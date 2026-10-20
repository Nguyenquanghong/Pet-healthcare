"""Offline Q6 evidence evaluation. Never starts services, extracts files or writes a DB.

This evaluator deliberately cannot approve deployment: enforced total budgets,
PCN calendar timing/CPU measurement boundaries and Q2-Q5 sign-off need separate
evidence. A latency gate passing is distinct from the whole Q6 passing.
"""
import argparse
from collections import Counter
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import stat
import statistics
from zipfile import ZipFile

import cqrs_source

OPERATIONS = ('owner-list', 'admin-list', 'admin-search', 'admin-unbilled',
              'owner-calendar', 'admin-calendar', 'admin-filter', 'admin-page')
PCN_OPERATIONS = ('GET pets', 'GET appointments', 'GET medical by pet', 'GET hotel',
                  'GET invoices', 'GET notifications', 'POST appointment', 'POST rescue report')
TRIALS = ('smoke-O', 'smoke-A', 'smoke-B', 'O-1', 'O-2', 'O-3',
          'pair-1-A', 'pair-1-B', 'pair-2-B', 'pair-2-A', 'pair-3-A', 'pair-3-B')
TRIAL_FILES = ('report.json', 'requests.jsonl', 'resources.jsonl', 'database.jsonl',
               'cqrs.jsonl', 'read-diagnostics.jsonl', 'query-plans.json', 'manifest.json',
               'pcn-report.json', 'http.csv', 'http-summary.json', 'load-final.json',
               'generator.json', 'reconciliation.json')
MAX_BYTES = 512 * 1024 * 1024


class EvidenceError(ValueError):
    """Only fixed diagnostic codes may cross the CLI boundary."""


def require(condition, code):
    if not condition:
        raise EvidenceError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def decode(data):
    return json.loads(data, parse_constant=lambda _: require(False, 'NONFINITE_JSON'))


def number(value):
    require(type(value) in (int, float) and math.isfinite(value) and value >= 0, 'NUMBER')
    return value


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[math.ceil(len(ordered) * fraction) - 1] if ordered else None


def change(before, after):
    return (after / before - 1) * 100 if before and after is not None else None


def gate(name, status, **details):
    return {'gate': name, 'status': status, **details}


def allowed_paths():
    result = {'summary.json', 'setup-versions.json', 'result-manifest.json'}
    for workload in ('query-heavy', 'pcn'):
        result.update(f'{workload}/{name}' for name in ('environment.json', 'run.json', 'trials/workflow.json'))
        result.update(f'{workload}/trials/{trial}/{name}' for trial in TRIALS for name in TRIAL_FILES)
    return result


def read_results(path):
    path = Path(path)
    require(path.stat().st_size <= MAX_BYTES, 'ARCHIVE_SIZE')
    return read_result_archive(path.read_bytes())


def read_result_archive(raw):
    require(len(raw) <= MAX_BYTES, 'ARCHIVE_SIZE')
    with ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        require(0 < len(infos) <= 400 and sum(i.file_size for i in infos) <= MAX_BYTES, 'ARCHIVE_SIZE')
        names = [i.filename for i in infos]
        require(len(set(n.casefold() for n in names)) == len(names), 'DUPLICATE_PATH')
        require(set(names) <= allowed_paths(), 'ARCHIVE_SCOPE')
        require(all(not i.is_dir() and stat.S_IFMT(i.external_attr >> 16) in (0, stat.S_IFREG)
                    and not i.flag_bits & 1 for i in infos), 'ARCHIVE_FILE_TYPE')
        payload = {i.filename: archive.read(i) for i in infos}
    manifest = decode(payload['result-manifest.json'])
    expected = sorted(manifest['files'], key=lambda row: row['path'])
    actual = [{'path': name, 'bytes': len(data), 'sha256': digest(data)}
              for name, data in sorted(payload.items()) if name != 'result-manifest.json']
    require(actual == expected, 'RESULT_HASH_OR_INVENTORY')
    return payload, manifest


def records(payload, prefix, filename):
    return [decode(line) for line in payload[prefix + filename].splitlines() if line.strip()]


def correct_path(row, configuration):
    if configuration == 'O':
        return row.get('read_source') == 'absent' and row.get('degraded') is False
    if configuration == 'A':
        return row.get('read_source') == 'authoritative' and row.get('degraded') is False
    if row['operation'] == 'admin-unbilled':
        return row.get('read_source') == 'authoritative' and row.get('degraded') is True
    return (row.get('read_source') == 'projection' and row.get('generation_matches') is True
            and row.get('degraded') is False)


def summarize_query(rows, configuration, seconds):
    """Every scheduled arrival stays in the denominator, including drops/errors."""
    seen = set()
    for row in rows:
        require(row['operation'] in OPERATIONS, 'QUERY_OPERATION')
        seq = row['sequence']
        require(type(seq) is int and seq >= 0 and seq not in seen, 'QUERY_SEQUENCE')
        seen.add(seq)
        require(type(row['sent']) is bool and type(row['status']) is int, 'QUERY_REQUEST')
        number(row['lag_ms'])
        if row['sent']:
            number(row['latency_ms'])
        number(row['total_ms'])
    require(seen == set(range(len(rows))), 'QUERY_SEQUENCE')
    summaries = {}
    for op in OPERATIONS:
        group = [r for r in rows if r['operation'] == op]
        sent = [r for r in group if r['sent']]
        http_ok = [r for r in sent if 200 <= r['status'] < 300]
        success = [r for r in http_ok if r['outcome'] == 'success' and correct_path(r, configuration)]
        summaries[op] = {
            'scheduled': len(group), 'sent': len(sent), 'success': len(success),
            'dropped': len(group) - len(sent),
            'success_ratio_of_scheduled': len(success) / len(group) if group else None,
            'success_rps': len(success) / seconds if seconds else None,
            'http_429': sum(r['status'] == 429 for r in group),
            'http_503': sum(r['status'] == 503 for r in group),
            'other_unsuccessful': len(sent) - len(success) - sum(r['status'] in (429, 503) for r in sent),
            'unexpected_error_ratio': sum(r['outcome'] in ('transport_error', 'contract_error', 'overload', 'http_error')
                                          for r in group) / len(group) if group else None,
            'wrong_read_path': sum(not correct_path(r, configuration) for r in http_ok),
            'read_sources': dict(sorted(Counter(r.get('read_source', 'absent')
                                               if r.get('read_source') in ('projection', 'authoritative', 'absent')
                                               else 'invalid' for r in sent).items())),
            'p95_success_ms': percentile([r['latency_ms'] for r in success], .95),
            'p99_success_ms': percentile([r['latency_ms'] for r in success], .99),
            'p95_all_http_ms': percentile([r['latency_ms'] for r in sent], .95),
            'p95_schedule_to_done_ms': percentile([r['total_ms'] for r in group], .95),
        }
    return summaries


def cpu_query(rows, successes, seconds, configuration):
    """Sampled measured intervals; include PG, all workers, broker and generator."""
    components = {}
    for row in rows:
        if row.get('phase') != 'measured' or row.get('cpu_seconds_delta') is None:
            continue
        name = row['component']
        # Fixed labels only. Never echo arbitrary input in a report.
        allowed = {'billing-worker', 'clinic-0', 'clinic-read-worker', 'clinic-worker', 'core',
                   'core-outbox', 'generator', 'nginx', 'notification', 'notification-worker',
                   'postgres', 'rabbitmq', 'redis', 'stack-supervisor'}
        require(name in allowed, 'CPU_COMPONENT')
        item = components.setdefault(name, {'cpu_seconds': 0, 'coverage_seconds': 0})
        item['cpu_seconds'] += number(row['cpu_seconds_delta'])
        item['coverage_seconds'] += number(row['interval_seconds'])
    required = {'billing-worker', 'clinic-0', 'clinic-worker', 'core', 'core-outbox', 'generator',
                'nginx', 'notification', 'notification-worker', 'postgres', 'rabbitmq', 'redis',
                'stack-supervisor'} | ({'clinic-read-worker'} if configuration != 'O' else set())
    coverage_ok = bool(seconds) and required <= components.keys() and all(
        .9 * seconds <= v['coverage_seconds'] <= 1.05 * seconds for v in components.values())
    total = sum(v['cpu_seconds'] for v in components.values())
    return {'components': dict(sorted(components.items())), 'coverage_valid': coverage_ok,
            'total_cpu_seconds_observed': total,
            'cpu_seconds_per_success_observed': total / successes if successes else None,
            'note': 'Sampled measured intervals, not exact whole-window CPU; includes generator.'}


def query_trial(payload, name, policy):
    prefix = f'query-heavy/trials/{name}/'
    report = decode(payload[prefix + 'report.json'])
    configuration = name[-1] if name.startswith(('smoke-', 'pair-')) else 'O'
    require(report['configuration'] == configuration, 'QUERY_CONFIGURATION')
    rows = records(payload, prefix, 'requests.jsonl')
    require(all(r.get('phase') in ('warmup', 'measured') for r in rows), 'QUERY_PHASE')
    require(all(r['operation'] == OPERATIONS[r['sequence'] % len(OPERATIONS)] for r in rows), 'QUERY_OPERATION_SEQUENCE')
    settings = report['settings']
    seconds = number(settings['seconds'])
    summaries = {phase: summarize_query([r for r in rows if r['phase'] == phase], configuration,
                                       number(settings['warmup']) if phase == 'warmup' else seconds)
                 for phase in ('warmup', 'measured')}
    measured = summaries['measured']
    scheduled = sum(s['scheduled'] for s in measured.values())
    success = sum(s['success'] for s in measured.values())
    require(scheduled == report.get('measured', {}).get('scheduled', 0)
            and scheduled == round(seconds * number(settings['rate'])), 'QUERY_COUNT_MISMATCH')
    lag = percentile([r['lag_ms'] for r in rows if r['phase'] == 'measured' and r['sent']], .95)
    drops = sum(s['dropped'] for s in measured.values())
    generator_valid = bool(scheduled) and drops / scheduled <= .001 and lag is not None and lag <= 50
    q = policy['benchmark']['queryHeavy']
    full = report['mode'] == 'full' and name != 'smoke-' + configuration
    profile_valid = (settings['warmup'] >= q['warmupSecondsMin'] and seconds >= q['steadySecondsMin']
                     and report['dataset']['appointments'] == q['appointments'])
    sample_valid = all(s['success'] >= q['samplesPerOperationPerRunMin'] for s in measured.values())
    contract_valid = (report.get('reconciliation', {}).get('status') == 'PASS'
                      and not report.get('collection_errors') and report.get('process_sample_errors') == 0
                      and report.get('status') in ('SMOKE_PASS', 'BENCHMARK_RUN_RECORDED')
                      and len(report.get('preflight', [])) >= 3
                      and all(c.get('valid') is True for c in report['preflight'])
                      and all(s['success'] == s['scheduled'] for s in summaries['warmup'].values()))
    path_valid = all(s['wrong_read_path'] == 0 for phase in summaries.values() for s in phase.values())
    cqrs = report['cqrs']
    require(cqrs['readMode'] == ('projection' if configuration == 'B' else 'authoritative')
            and cqrs['projectorEnabled'] is (configuration != 'O') and cqrs['shadowEnabled'] is False,
            'QUERY_CQRS_CONFIGURATION')
    nfr_valid = all(s['success_ratio_of_scheduled'] is not None and s['success_ratio_of_scheduled'] >= .99
                    and s['unexpected_error_ratio'] < .01
                    and s['p95_success_ms'] is not None and s['p95_success_ms'] <= 750
                    and s['p99_success_ms'] <= 1500 for s in measured.values())
    return {'configuration': configuration, 'run': report['run'], 'full': full,
            'warmup_seconds': settings['warmup'], 'measured_seconds': seconds,
            'settings': {k: number(settings[k]) for k in ('rate', 'concurrency')},
            'profile_valid': profile_valid, 'sample_valid': sample_valid, 'contract_valid': contract_valid,
            'read_path_valid': path_valid, 'generator_valid': generator_valid, 'nfr_valid': nfr_valid,
            'scheduler_lag_p95_ms': lag, 'warmup': summaries['warmup'], 'measured': measured,
            'success_rps': success / seconds if seconds else None,
            'cpu': cpu_query(records(payload, prefix, 'resources.jsonl'), success, seconds, configuration)}


def primary_comparison(trials, policy):
    """The primary endpoint is frozen; secondary winners cannot rescue this gate."""
    require(policy['primaryEndpoint'] == 'GET /api/appointments', 'PRIMARY_ENDPOINT_DRIFT')
    pairs = []
    for i in range(1, 4):
        a, b = trials.get(f'pair-{i}-A'), trials.get(f'pair-{i}-B')
        if a is None or b is None:
            return gate('query_primary_admin_list', 'NOT_RUN', pairs=pairs, required_pairs=3)
        if not all(t['full'] and t['profile_valid'] for t in (a, b)):
            return gate('query_primary_admin_list', 'INVALID_ENVIRONMENT')
        if not all(t['sample_valid'] for t in (a, b)):
            return gate('query_primary_admin_list', 'INSUFFICIENT_SAMPLES')
        if a['settings'] != b['settings']:
            return gate('query_primary_admin_list', 'INVALID_ENVIRONMENT', reason='PAIRED_LOAD_MISMATCH')
        if not all(t['contract_valid'] and t['read_path_valid'] and t['generator_valid'] and t['nfr_valid']
                   for t in (a, b)):
            return gate('query_primary_admin_list', 'FAIL', reason='CONTRACT_PATH_GENERATOR_OR_NFR')
        x, y = (t['measured']['admin-list']['p95_success_ms'] for t in (a, b))
        require(x > 0 and y > 0, 'ZERO_PRIMARY_LATENCY')
        pairs.append({'pair': i, 'A_p95_ms': x, 'B_p95_ms': y, 'B_change_percent': change(x, y)})
    a = statistics.median(p['A_p95_ms'] for p in pairs)
    b = statistics.median(p['B_p95_ms'] for p in pairs)
    improvement = -change(a, b)
    rules = policy['benchmark']
    passed = (improvement + 1e-9 >= rules['medianListP95ImprovementPercentMin']
              and all(p['B_change_percent'] <= rules['pairedListP95RegressionPercentMax'] + 1e-9 for p in pairs))
    return gate('query_primary_admin_list', 'PASS' if passed else 'FAIL', pairs=pairs,
                median_A_p95_ms=a, median_B_p95_ms=b, median_improvement_percent=improvement,
                target_improvement_percent=rules['medianListP95ImprovementPercentMin'])


def operation_comparisons(trials, *, smoke=False):
    result = {}
    groups = {c: [trials.get('smoke-' + c)] if smoke else
              [trials.get(f'O-{i}' if c == 'O' else f'pair-{i}-{c}') for i in range(1, 4)] for c in 'OAB'}
    for op in OPERATIONS:
        values = {c: [t['measured'][op]['p95_success_ms'] for t in group if t is not None]
                  for c, group in groups.items()}
        medians = {c: statistics.median(v) if v and all(x is not None for x in v) else None
                   for c, v in values.items()}
        result[op] = {'p95_ms_by_run': values, 'median_p95_ms': medians,
                      'B_vs_A_percent': change(medians['A'], medians['B']),
                      'B_vs_O_percent': change(medians['O'], medians['B'])}
    return result


def pcn_trial(payload, name, policy):
    prefix = f'pcn/trials/{name}/'
    manifest = decode(payload[prefix + 'manifest.json'])
    configuration = name[-1] if name.startswith(('smoke-', 'pair-')) else 'O'
    require(manifest['configuration'] == configuration, 'PCN_CONFIGURATION')
    raw = records(payload, prefix, 'requests.jsonl')
    http = list(csv.DictReader(io.StringIO(payload[prefix + 'http.csv'].decode('utf-8'))))
    load = decode(payload[prefix + 'load-final.json'])
    require(len(raw) == len(http) == load['requests'] == load['started_requests'], 'PCN_COUNT_MISMATCH')
    require(sum(a['failed'] for a in raw) == load['failures'], 'PCN_FAILURE_COUNT_MISMATCH')
    rows = []
    for a, b in zip(raw, http):
        require(a['name'] in PCN_OPERATIONS and a['name'] == b['operation']
                and abs(number(a['response_time_ms']) - number(float(b['latency_ms']))) < .001
                and abs(number(a['started_seconds']) - number(float(b['started_seconds']))) < .001,
                'PCN_RAW_MISMATCH')
        require(type(a['failed']) is bool and b['failed'] in ('True', 'False'), 'PCN_FAILURE_FLAG')
        status = int(b['status'])
        ok = not a['failed'] and b['failed'] == 'False' and 200 <= status < 300
        path_ok = (b['read_source'] == ('projection' if configuration == 'B' else
                                      'authoritative' if configuration == 'A' else 'absent')
                   and b['degraded'] == 'False') if a['name'] == 'GET appointments' else True
        rows.append({'operation': a['name'], 'latency_ms': a['response_time_ms'], 'success': ok,
                     'status': status, 'path_ok': path_ok})
    seconds = number(load['measured_seconds'])
    endpoints = {}
    for op in PCN_OPERATIONS:
        group = [r for r in rows if r['operation'] == op]
        endpoints[op] = {'requests': len(group), 'failures': sum(not r['success'] for r in group),
                         'p95_all_ms': percentile([r['latency_ms'] for r in group], .95),
                         'within_2s_success_ratio': sum(r['success'] and r['latency_ms'] <= 2000 for r in group)
                         / len(group) if group else None}
    population = load['population_samples']
    full = manifest['mode'] == 'full' and not name.startswith('smoke-')
    config = policy['benchmark']['pcn']
    profile_valid = (seconds >= config['steadySeconds'] and population
                     and min(population) == max(population) == config['users']
                     and manifest['users'] == config['users'] and manifest['spawn_rate'] == config['spawnPerSecond']
                     and manifest['warmup'] >= config['warmupSeconds'] and load['completed'] is True)
    reconciliation = decode(payload[prefix + 'reconciliation.json'])
    runtime_ok = (manifest['status'] == 'COMPLETE'
                  and (manifest['locust_exit_code'] == 0 or manifest['locust_exit_code'] == 1 and load['failures'] > 0)
                  and manifest['process_sample_errors'] == 0
                  and decode(payload[prefix + 'generator.json'])['user_errors'] == 0
                  and reconciliation['status'] == 'PASS_IN_SCOPE'
                  and all(reconciliation.get(k) == 0 for k in ('missing_success_ids', 'writes_without_success_response',
                                                             'duplicate_active_slots', 'duplicate_response_ids'))
                  and reconciliation['unexpected_child_exit'] is False)
    successes = sum(r['success'] for r in rows)
    nfr_valid = bool(rows) and 1 - successes / len(rows) <= .01 and all(
        e['requests'] > 0 and e['p95_all_ms'] <= 2000 and e['within_2s_success_ratio'] >= .95
        for e in endpoints.values())
    cqrs = manifest['cqrs']
    require(cqrs['readMode'] == ('projection' if configuration == 'B' else 'authoritative')
            and cqrs['projectorEnabled'] is (configuration != 'O') and cqrs['shadowEnabled'] is False,
            'PCN_CQRS_CONFIGURATION')
    return {'configuration': configuration, 'run': manifest['run'], 'full': full,
            'measured_seconds': seconds, 'users_min': min(population) if population else None,
            'users_max': max(population) if population else None, 'profile_valid': bool(profile_valid),
            'contract_valid': runtime_ok, 'read_path_valid': all(r['path_ok'] for r in rows),
            'nfr_valid': nfr_valid, 'requests': len(rows), 'success': successes,
            'success_rps': successes / seconds if seconds else None,
            'http_429': sum(r['status'] == 429 for r in rows), 'http_503': sum(r['status'] == 503 for r in rows),
            'endpoints': endpoints}


def regression_gate(name, configurations, field, maximum):
    values = {c: [field(t) for t in group] for c, group in configurations.items()}
    if not all(len(v) == 3 and all(x is not None and x > 0 for x in v) for v in values.values()):
        return gate(name, 'NOT_RUN')
    medians = {c: statistics.median(v) for c, v in values.items()}
    changes = {c: change(medians['O'], medians[c]) for c in ('A', 'B')}
    return gate(name, 'PASS' if all(v <= maximum + 1e-9 for v in changes.values()) else 'FAIL',
                values_by_run=values, median=medians, change_vs_O_percent=changes, maximum_percent=maximum)


def workload_gates(query, pcn, policy):
    rules = policy['benchmark']
    gates = [primary_comparison(query, policy)]
    for workload, trials in (('query', query), ('pcn', pcn)):
        groups = {c: [trials[name] for i in range(1, 4)
                      if (name := (f'O-{i}' if c == 'O' else f'pair-{i}-{c}')) in trials] for c in 'OAB'}
        complete = all(len(v) == 3 for v in groups.values())
        usable = complete and all(t['full'] and t['profile_valid'] for ts in groups.values() for t in ts)
        gates.append(gate(workload + '_full_profile', 'PASS' if usable else
                          'INVALID_ENVIRONMENT' if complete else 'NOT_RUN'))
        if not usable:
            continue
        valid = all(t['contract_valid'] and t['read_path_valid'] and t['nfr_valid']
                    and (t.get('generator_valid', True)) for ts in groups.values() for t in ts)
        gates.append(gate(workload + '_contract_path_nfr', 'PASS' if valid else 'FAIL'))
        if workload == 'query':
            sufficient = all(t['sample_valid'] for ts in groups.values() for t in ts)
            gates.append(gate('query_samples_all_operations', 'PASS' if sufficient else 'INSUFFICIENT_SAMPLES'))
            if not sufficient or not valid:
                continue
            cpu_valid = all(t['cpu']['coverage_valid'] for ts in groups.values() for t in ts)
            gates.append(regression_gate('query_total_cpu_per_success_vs_O', groups,
                lambda t: t['cpu']['cpu_seconds_per_success_observed'],
                rules['totalCpuSecondsPerSuccessIncreaseVsOPercentMax']) if cpu_valid else
                gate('query_total_cpu_per_success_vs_O', 'INCONCLUSIVE', reason='CPU_COMPONENTS_OR_COVERAGE'))
        else:
            if not valid:
                continue
            for op in ('POST appointment', 'POST rescue report'):
                gates.append(regression_gate('pcn_' + op.replace(' ', '_') + '_p95_vs_O', groups,
                    lambda t, op=op: t['endpoints'][op]['p95_all_ms'], rules['writeP95RegressionVsOPercentMax']))
            changes = [change(groups['A'][i]['endpoints']['GET appointments']['p95_all_ms'],
                              groups['B'][i]['endpoints']['GET appointments']['p95_all_ms']) for i in range(3)]
            gates.append(gate('pcn_list_p95_B_vs_A', 'PASS' if all(v is not None and
                v <= rules['pcnListAndCalendarRegressionPercentMax'] + 1e-9 for v in changes) else 'FAIL',
                paired_change_percent=changes))
        # Negate changes so a throughput decrease has a positive regression value.
        throughput = regression_gate(workload + '_successful_throughput_vs_O', groups,
            lambda t: t['success_rps'], 1e100)
        if throughput['status'] != 'NOT_RUN':
            throughput['maximum_regression_percent'] = rules['successfulThroughputRegressionVsOPercentMax']
            throughput['status'] = 'PASS' if all(-v <= rules['successfulThroughputRegressionVsOPercentMax'] + 1e-9
                for v in throughput['change_vs_O_percent'].values()) else 'FAIL'
            throughput.pop('maximum_percent')
        gates.append(throughput)
    return gates


def evaluate(payload, source_manifest, source_sha, policy, plan):
    require(decode(payload['result-manifest.json'])['source_archive_sha256'] == source_sha, 'SOURCE_ARCHIVE_HASH')
    trials = {'query-heavy': {}, 'pcn': {}}
    gates = [gate('source_policy_result_integrity', 'PASS')]
    run_ids = set()
    for workload in trials:
        key = workload + '/environment.json'
        if key not in payload:
            require(not any(p.startswith(workload + '/') for p in payload), 'ENVIRONMENT_MISSING')
            continue
        env = decode(payload[key])
        require(env['source_archive_sha256'] == source_sha and env['source_manifest_sha256'] == source_manifest['sha256']
                and env['sources'] == source_manifest['sources'] and env['policy_sha256'] == cqrs_source.POLICY_SHA
                and env['plan'] == plan, 'SOURCE_POLICY_PLAN_MISMATCH')
        workflow = decode(payload[workload + '/trials/workflow.json'])
        expected = [t for t in plan['trials'] if t['workload'] == workload and
                    (workflow['full'] or t['phase'] == 'smoke')]
        entries = workflow['trials']
        require(len(entries) <= len(expected), 'TRIAL_ORDER')
        for row, wanted in zip(entries, expected):
            require(all(row.get(k) == wanted[k] for k in wanted), 'TRIAL_ORDER')
        listed = {r['name'] for r in entries}
        require(all(p.split('/')[2] in listed for p in payload
                    if p.startswith(workload + '/trials/') and len(p.split('/')) == 4), 'UNLISTED_TRIAL')
        for row in entries:
            name = row['name']
            prefix = workload + '/trials/' + name + '/'
            required = ('report.json', 'requests.jsonl', 'resources.jsonl') if workload == 'query-heavy' else (
                'manifest.json', 'requests.jsonl', 'http.csv', 'load-final.json', 'reconciliation.json', 'generator.json')
            if not all(prefix + f in payload for f in required):
                gates.append(gate(workload + '_' + name + '_artifact', 'NOT_RUN'))
                continue
            result = query_trial(payload, name, policy) if workload == 'query-heavy' else pcn_trial(payload, name, policy)
            if workload == 'query-heavy' and result['full']:
                profile = plan['query_heavy']
                result['profile_valid'] = result['profile_valid'] and (
                    result['settings']['rate'] == profile['rate']
                    and result['settings']['concurrency'] == profile['concurrency']
                    and result['warmup_seconds'] == profile['warmup_seconds']
                    and result['measured_seconds'] == profile['steady_seconds'])
            require(result['run'] == row['run'] and result['run'] not in run_ids, 'DUPLICATE_OR_WRONG_RUN')
            run_ids.add(result.pop('run'))
            trials[workload][name] = result
            # Failures are retained even if measurement is too short to decide speed.
            gates.append(gate(workload + '_' + name + '_contract_path', 'PASS' if
                              result['contract_valid'] and result['read_path_valid'] else 'FAIL'))
            if workload == 'query-heavy' and name.startswith('smoke-'):
                gates.append(gate('query-heavy_' + name + '_acceptance_samples', 'PASS' if result['sample_valid']
                                  else 'INSUFFICIENT_SAMPLES'))
    query, pcn = trials['query-heavy'], trials['pcn']
    gates.extend(workload_gates(query, pcn, policy))
    gates.extend([
        gate('equal_enforced_total_resource_budget', 'INCONCLUSIVE', reason='NOT_PROVEN_BY_NATIVE_V9_EXPORT'),
        gate('pcn_calendar_regression', 'NOT_RUN', reason='CALENDAR_ABSENT_FROM_FROZEN_PCN_TASKS'),
        gate('pcn_measured_generation_identity', 'NOT_RUN', reason='GENERATION_ONLY_IN_PREFLIGHT_NOT_HTTP_CSV'),
        gate('pcn_measured_total_cpu_per_success', 'NOT_RUN', reason='RESOURCE_SAMPLES_INCLUDE_RAMP_AND_WARMUP_WITHOUT_BOUNDARIES'),
        gate('Q2_Q5_correctness_freshness_recovery_signoff', 'NOT_RUN', reason='SEPARATE_TRIAL_EVIDENCE_REQUIRED'),
        gate('database_io_and_disk_comparison', 'NOT_RUN', reason='SEPARATE_RESOURCE_REVIEW_REQUIRED'),
    ])
    fail = any(g['status'] == 'FAIL' for g in gates)
    invalid = any(g['status'] == 'INVALID_ENVIRONMENT' for g in gates)
    return {'format': 'cqrs-q6-evaluation-v1', 'source_archive_sha256': source_sha,
            'policy_sha256': cqrs_source.POLICY_SHA, 'primary_operation': 'admin-list',
            'decision': 'INVALID_ENVIRONMENT' if invalid else 'FAIL' if fail else 'INCONCLUSIVE',
            'significant_improvement_proven': False, 'capacity_accepted': False, 'deployment_accepted': False,
            'gates': gates, 'trials': trials,
            'smoke_observations_only': operation_comparisons(query, smoke=True),
            'full_observations': operation_comparisons(query),
            'limitations': ['Smoke percentiles are descriptive, never substituted for full pairs.',
                'Latency differences include the entire candidate change, not isolated CQRS causality.',
                'All gates must be resolved before deployment; this tool does not switch read mode.']}


def markdown(report):
    lines = ['# CQRS Q6 evaluation', '', '**Decision: ' + report['decision'] + '**', '',
             'Significant improvement proven: **false**. Deployment/capacity accepted: **false**.', '',
             '## Smoke observations (not acceptance)', '',
             '| Operation | O p95 ms | A p95 ms | B p95 ms | B vs A |', '|---|---:|---:|---:|---:|']
    def fmt(value):
        return 'N/A' if value is None else f'{value:.2f}'
    for op, result in report.get('smoke_observations_only', {}).items():
        med = result['median_p95_ms']
        lines.append(f'| {op} | {fmt(med["O"])} | {fmt(med["A"])} | {fmt(med["B"])} | '
                     f'{fmt(result["B_vs_A_percent"])}% |')
    lines += ['', '## Gates', '', '| Gate | Status |', '|---|---|']
    lines.extend('| ' + g['gate'] + ' | ' + g['status'] + ' |' for g in report['gates'])
    lines += ['', 'Full per-run measurements, raw errors, CPU components and gate details are in evaluation.json.', '']
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--source-bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New directory; existing output is never overwritten')
    args = parser.parse_args()
    try:
        require(not args.output.exists(), 'OUTPUT_EXISTS')
        payload, _ = read_results(args.results)
        source, manifest, sha = cqrs_source.read_bundle(args.source_bundle)
        report = evaluate(payload, manifest, sha, decode(source['policy.json']), decode(source['plan.json']))
        report['result_archive_sha256'] = digest(args.results.read_bytes())
        report['evaluator_sha256'] = digest(Path(__file__).read_bytes())
        args.output.mkdir(parents=True, exist_ok=False)
        (args.output / 'evaluation.json').write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
        (args.output / 'evaluation.md').write_text(markdown(report), encoding='utf-8')
        print(json.dumps({k: report[k] for k in ('decision', 'significant_improvement_proven', 'capacity_accepted')}))
        return 1 if report['decision'] in ('FAIL', 'INVALID_ENVIRONMENT') else 0
    except Exception as error:
        # Never echo JSON fields, filenames from an archive or exception messages.
        code = str(error) if type(error) is EvidenceError else 'MALFORMED_OR_UNREADABLE_EVIDENCE'
        print(json.dumps({'decision': 'INVALID_ENVIRONMENT', 'error_code': code}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
