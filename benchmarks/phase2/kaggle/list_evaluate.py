"""Grade cqrs-list-matched-kaggle-v1 outcomes against the frozen list policy.

Pure functions over recorded data; no I/O except the CLI. Latency is graded on
successes with nearest-rank percentiles: open loop uses scheduled -> completion
(total_ms), closed loop request start -> completion. Ratios are computed inside
each matched block, then median and worst across blocks; every block must share
one profileKey. Missing CPU coverage makes the CPU gate TOTAL_COST_INCONCLUSIVE;
it never passes by default. Improvement claims use the query-heavy primary only.
"""
import json
import math
from pathlib import Path
import statistics

PRIMARY = 'admin-list'
CALENDARS = ('owner-calendar', 'admin-calendar')
PCN_LIST = 'GET appointments'
PCN_WRITES = ('POST appointment', 'POST rescue report')
EPS = 1e-9


def nearest_rank(values, q):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(q * len(ordered)) - 1)] if ordered else None


def ratio(a, b):
    return a / b if a is not None and b not in (None, 0) else None


def expected_path(configuration, *, unbilled=False):
    return 'absent' if configuration == 'O' else 'projection' if configuration == 'B' and not unbilled else 'authoritative'


def query_member(member, policy):
    """member: {configuration, report, rows}. Measured rows only are graded."""
    v = policy['generatorValidity']
    report, rows = member['report'], [r for r in member['rows'] if r.get('phase') == 'measured']
    seconds = report['measured']['seconds'] if 'measured' in report else None
    planned = round(report['settings']['rate'] * seconds) if seconds else 0
    sent = [r for r in rows if r.get('sent')]
    drops = sum(r.get('outcome') == 'generator_drop' for r in rows)
    lateness = [r['lag_ms'] for r in sent]
    inside = sum(r['scheduled_s'] * 1000 + r['lag_ms'] <= seconds * 1000 for r in sent) if seconds else 0
    validity = {'planned': planned, 'recorded': len(rows), 'drops': drops,
                'latenessP99Ms': nearest_rank(lateness, .99), 'latenessMaxMs': max(lateness) if lateness else None,
                'insideFraction': inside / planned if planned else 0}
    reasons = [n for n, bad in (('planned_count_changed', len(rows) != planned or not planned),
                                ('generator_drops', drops > v['maximumGeneratorDropsForHealthyAcceptance']),
                                ('lateness_p99', validity['latenessP99Ms'] is None or validity['latenessP99Ms'] > v['dispatchLatenessP99MaxMs'] + EPS),
                                ('lateness_max', validity['latenessMaxMs'] is None or validity['latenessMaxMs'] > v['dispatchLatenessMaxMs'] + EPS),
                                ('inside_window', validity['insideFraction'] < v['minimumPlannedDispatchFractionInsideMeasuredWindow'] - EPS)) if bad]
    validity.update(valid=not reasons, reasons=reasons)
    operations = {}
    for op in sorted({r['operation'] for r in rows if r.get('operation') != 'generator.drop'}):
        group = [r for r in rows if r.get('operation') == op]
        good = [r['total_ms'] for r in group if r.get('outcome') == 'success']
        operations[op] = {'scheduled': len(group), 'success': len(good),
                          'errors': sum(r.get('outcome') not in ('success', 'generator_drop') for r in group),
                          'p50Ms': nearest_rank(good, .5), 'p95Ms': nearest_rank(good, .95), 'p99Ms': nearest_rank(good, .99)}
    successes = sum(o['success'] for o in operations.values())
    errors = sum(o['errors'] for o in operations.values())
    return {'validity': validity, 'operations': operations, 'successes': successes, 'errors': errors,
            'successPerSecond': successes / seconds if seconds else None}


def pcn_member(member, policy):
    """member: {configuration, report, rows (overlay raw), probe}. Rows are measured-window only."""
    v = policy['generatorValidity']
    report, rows = member['report'], member['rows']
    window = report.get('window') or {}
    seconds = report['settings']['seconds']
    delays = [p['delayMs'] for p in member.get('probe', [])]
    validity = {'completed': window.get('completed') is True, 'targetUsers': window.get('targetUsers'),
                'populationMin': window.get('populationMin'), 'populationMax': window.get('populationMax'),
                'probeSamples': len(delays), 'probeP99Ms': nearest_rank(delays, .99), 'probeMaxMs': max(delays) if delays else None,
                'timestampsComplete': all(r.get('startMonotonic') is not None and r.get('user') is not None for r in rows) and bool(rows)}
    reasons = [n for n, bad in (('window_incomplete', not validity['completed']),
                                ('population', not (validity['populationMin'] == validity['populationMax'] == validity['targetUsers'])),
                                ('probe_missing', len(delays) < 0.9 * seconds * 10),
                                ('probe_p99', validity['probeP99Ms'] is None or validity['probeP99Ms'] > v['dispatchLatenessP99MaxMs'] + EPS),
                                ('probe_max', validity['probeMaxMs'] is None or validity['probeMaxMs'] > v['dispatchLatenessMaxMs'] + EPS),
                                ('timestamps', not validity['timestampsComplete'])) if bad]
    validity.update(valid=not reasons, reasons=reasons)
    expected = expected_path(member['configuration'])
    lists = [r for r in rows if r['name'] == PCN_LIST and not r['failed']]
    projected = lambda r: r['readSource'] == expected and (expected != 'projection' or r['generationMatches'])
    # policy pcnReadPath: B may answer from authoritative only as a declared V1 bounded fallback.
    fallback = lambda r: expected == 'projection' and r['readSource'] == 'authoritative' and r.get('degraded') is True
    path_errors = sum(not projected(r) and not fallback(r) for r in lists)
    fallbacks = sum(fallback(r) for r in lists)
    operations = {}
    for name in sorted({r['name'] for r in rows}):
        group = [r for r in rows if r['name'] == name]
        good = [r['latencyMs'] for r in group if not r['failed']]
        operations[name] = {'requests': len(group), 'success': len(good), 'errors': len(group) - len(good),
                            'p50Ms': nearest_rank(good, .5), 'p95Ms': nearest_rank(good, .95), 'p99Ms': nearest_rank(good, .99)}
    successes = sum(o['success'] for o in operations.values())
    errors = sum(o['errors'] for o in operations.values())
    return {'validity': validity, 'operations': operations, 'successes': successes, 'errors': errors, 'pathErrors': path_errors,
            'listFallbacks': fallbacks, 'listFallbackRate': fallbacks / len(lists) if lists else None,
            'reconciliation': (report.get('reconciliation') or {}).get('status'), 'successPerSecond': successes / seconds}


def member_metrics(member, policy):
    m = (query_member if member['workload'] == 'query-heavy' else pcn_member)(member, policy)
    cpu = member.get('cpu') or {}
    m['cpu'] = {'complete': cpu.get('complete') is True, 'reasons': cpu.get('reasons', ['missing']),
                'applicationCpuSeconds': cpu.get('applicationCpuSeconds'), 'totalEnvelopeCpuSeconds': cpu.get('totalEnvelopeCpuSeconds'),
                'separateCpuSeconds': cpu.get('separateCpuSeconds')}
    m['cpuPerSuccess'] = cpu['applicationCpuSeconds'] / m['successes'] if m['cpu']['complete'] and m['successes'] else None
    m['status'] = member['report'].get('status')
    correctness = m['status'] == 'COMPLETE' and m['errors'] == 0 and m.get('pathErrors', 0) == 0
    if member['workload'] == 'pcn':
        correctness = correctness and m['reconciliation'] == 'PASS_IN_SCOPE'
    m['correct'] = correctness
    return m


def pool_check(peaks, configuration, policy):
    """Observed per-database-role peak <= sum of ceilings of the processes sharing it (F2)."""
    pools, harness = policy['profile']['poolCeilingsPerProcess'][configuration], policy['profile']['poolCeilingsPerProcess']['harness']['stack-supervisor-per-database']
    owners = {'p8_core': ('core-api', 'core-outbox', 'billing-worker'), 'p8_clinic': ('clinic-api', 'clinic-audit', 'clinic-worker', 'clinic-read-worker'),
              'p8_notification': ('notification-api', 'notification-worker')}
    rows = {role: {'peak': peaks.get(role, 0), 'ceiling': sum(pools.get(p, 0) for p in procs) + harness} for role, procs in owners.items()}
    unknown = sorted(set(peaks) - set(owners))
    return {'roles': rows, 'unknownRoles': unknown, 'pass': not unknown and all(r['peak'] <= r['ceiling'] for r in rows.values())}


def block_ratios(workload, metrics, policy):
    """metrics: {'O': m, 'A': m, 'B': m} of one complete block."""
    o, a, b = metrics['O'], metrics['A'], metrics['B']
    acc, out = policy['acceptance'], {}
    p95 = lambda m, op: m['operations'].get(op, {}).get('p95Ms')
    enough = lambda m, op, n: m['operations'].get(op, {}).get('success', 0) >= n
    if workload == 'query-heavy':
        n = policy['queryHeavy']['minimumSuccessfulSamplesPerOperationPerRun']
        out['primaryBtoA'] = ratio(p95(b, PRIMARY), p95(a, PRIMARY))
        out['primaryBtoO'] = ratio(p95(b, PRIMARY), p95(o, PRIMARY))
        out['primaryEnoughSamples'] = all(enough(m, PRIMARY, n) for m in (o, a, b))
        out['calendarBtoO'] = {op: ratio(p95(b, op), p95(o, op)) for op in CALENDARS}
        out['calendarEnoughSamples'] = all(enough(m, op, n) for m in (o, b) for op in CALENDARS)
    else:
        n = policy['pcn']['minimumSuccessfulAppointmentWriteSamplesPerConfiguration']
        out['listBtoO'] = ratio(p95(b, PCN_LIST), p95(o, PCN_LIST))
        out['writeBtoO'] = {op: ratio(p95(b, op), p95(o, op)) for op in PCN_WRITES}
        out['writeEnoughSamples'] = {op: enough(o, op, n) and enough(b, op, n) for op in PCN_WRITES}
    out['throughputBtoO'] = ratio(b['successPerSecond'], o['successPerSecond'])
    out['cpuPerSuccessBtoO'] = ratio(b['cpuPerSuccess'], o['cpuPerSuccess'])
    out['cpuComplete'] = o['cpu']['complete'] and b['cpu']['complete']
    out['informational'] = {'primaryAtoO': ratio(p95(a, PRIMARY), p95(o, PRIMARY)) if workload == 'query-heavy' else None,
                            'cpuPerSuccessAtoO': ratio(a['cpuPerSuccess'], o['cpuPerSuccess'])}
    return out


def gate(values, *, median_max=None, every_max=None, every_min=None):
    values = [v for v in values]
    if not values or any(v is None for v in values):
        return {'status': 'INCONCLUSIVE', 'values': values}
    med = statistics.median(values)
    ok = (median_max is None or med <= median_max + EPS) and (every_max is None or max(values) <= every_max + EPS) \
        and (every_min is None or min(values) >= every_min - EPS)
    return {'status': 'PASS' if ok else 'FAIL', 'median': med, 'worst': max(values) if every_min is None else min(values), 'values': values}


def evaluate_workload(workload, blocks, policy):
    """blocks: [{'index', 'profileKeySha256', 'members': {'O': member, ...}}] in planned order."""
    acc = policy['acceptance']
    result = {'workload': workload, 'blocks': [], 'gates': {}}
    complete = []
    for block in blocks:
        metrics = {c: member_metrics(m, policy) for c, m in block['members'].items()}
        entry = {'index': block['index'], 'profileKeySha256': block['profileKeySha256'],
                 'members': metrics, 'pools': {c: pool_check(block['members'][c]['report'].get('pool', {}).get('peaks', {}), c, policy) for c in metrics}}
        entry['complete'] = set(metrics) == {'O', 'A', 'B'} and all(m['status'] == 'COMPLETE' for m in metrics.values())
        entry['valid'] = entry['complete'] and all(m['validity']['valid'] for m in metrics.values())
        entry['correct'] = entry['complete'] and all(m['correct'] for m in metrics.values())
        if entry['complete']:
            entry['ratios'] = block_ratios(workload, metrics, policy)
            if entry['valid'] and entry['correct']:
                complete.append(entry)
        result['blocks'].append(entry)
    keys = {b['profileKeySha256'] for b in complete}
    result['comparableBlocks'] = len(complete)
    result['profileKeys'] = sorted(keys)
    g = result['gates']
    g['correctness'] = 'FAIL' if any(b['complete'] and not b['correct'] for b in result['blocks']) else 'PASS' if complete else 'NOT_RUN'
    g['environment'] = 'INVALID_ENVIRONMENT' if any(b['complete'] and not b['valid'] for b in result['blocks']) else 'VALID' if complete else 'NOT_RUN'
    g['pools'] = 'PASS' if all(p['pass'] for b in result['blocks'] for p in b['pools'].values()) else 'FAIL'
    if len(complete) < 3 or len(keys) != 1:
        result['status'] = 'INCONCLUSIVE_INSUFFICIENT_MATCHED_BLOCKS'
        return result
    r = [b['ratios'] for b in complete]
    nr = acc['wholeFeatureNonRegressionAgainstO']
    cpu = gate([x['cpuPerSuccessBtoO'] for x in r], every_max=nr['applicationCpuPerSuccessRatioMax'])
    if not all(x['cpuComplete'] for x in r):
        cpu = {'status': 'TOTAL_COST_INCONCLUSIVE', 'values': [x['cpuPerSuccessBtoO'] for x in r]}
    g['cpuPerSuccessBtoO'] = cpu
    g['throughputBtoO'] = gate([x['throughputBtoO'] for x in r], every_min=nr['successfulThroughputRatioMin'])
    if workload == 'query-heavy':
        enough = all(x['primaryEnoughSamples'] for x in r)
        rp, ri = acc['readPathImprovement'], acc['improvementAgainstPreCqrs']
        g['readPathImprovement'] = gate([x['primaryBtoA'] for x in r], median_max=rp['medianPairedBtoAP95RatioMax'], every_max=rp['everyPairRatioMax']) if enough else {'status': 'INSUFFICIENT_SAMPLES'}
        g['improvementAgainstPreCqrs'] = gate([x['primaryBtoO'] for x in r], median_max=ri['medianPairedBtoOP95RatioMax'], every_max=ri['everyPairRatioMax']) if enough else {'status': 'INSUFFICIENT_SAMPLES'}
        g['calendarBtoO'] = {op: gate([x['calendarBtoO'][op] for x in r], every_max=acc['queryHeavyOwnerAndAdminCalendarP95RatioToOMax'])
                             if all(x['calendarEnoughSamples'] for x in r) else {'status': 'INSUFFICIENT_SAMPLES'} for op in CALENDARS}
    else:
        g['listBtoO'] = gate([x['listBtoO'] for x in r], every_max=acc['pcnAppointmentListP95RatioMax'])
        g['writeBtoO'] = {op: gate([x['writeBtoO'][op] for x in r], every_max=nr['writeP95RatioMax']) if all(x['writeEnoughSamples'][op] for x in r)
                          else {'status': 'INCONCLUSIVE_INSUFFICIENT_WRITE_SAMPLES'} for op in PCN_WRITES}
    result['status'] = 'GRADED'
    return result


def flatten(gates):
    for key, value in gates.items():
        if isinstance(value, dict) and 'status' not in value:
            yield from ((key + '.' + k, v['status']) for k, v in value.items())
        else:
            yield key, value['status'] if isinstance(value, dict) else value


def decide(workloads, policy):
    """Study decision from the per-workload grades (both workloads required)."""
    by = {w['workload']: w for w in workloads}
    if any(w['gates'].get('correctness') == 'FAIL' for w in workloads):
        return 'FAIL_CORRECTNESS'
    if any(w['gates'].get('environment') == 'INVALID_ENVIRONMENT' for w in workloads):
        return 'INVALID_ENVIRONMENT'
    if set(by) != {'query-heavy', 'pcn'} or any(w['status'] != 'GRADED' for w in workloads):
        return 'INCONCLUSIVE'
    regression = [k for w in workloads for k, s in flatten(w['gates'])
                  if s == 'FAIL' and k not in ('readPathImprovement', 'improvementAgainstPreCqrs')]
    if regression:
        return 'REGRESSION'
    qh = by['query-heavy']['gates']
    inconclusive = [k for w in workloads for k, s in flatten(w['gates']) if s not in ('PASS', 'FAIL', 'VALID')]
    if qh['readPathImprovement']['status'] == 'PASS' and qh['improvementAgainstPreCqrs']['status'] == 'PASS':
        return 'INCONCLUSIVE' if inconclusive else 'WIN_IN_SCOPE'
    if qh['readPathImprovement']['status'] == 'PASS':
        return 'READ_PATH_BENEFIT_ONLY' if not inconclusive else 'INCONCLUSIVE'
    return 'NO_MEANINGFUL_BENEFIT' if not inconclusive else 'INCONCLUSIVE'


def evaluate(workloads, policy):
    graded = [evaluate_workload(w, blocks, policy) for w, blocks in workloads.items()]
    return {'study': policy['study'], 'policyVersion': policy['version'], 'workloads': graded,
            'decision': decide(graded, policy),
            'recommendation': 'NOT_RECOMMENDED_PENDING_FRESHNESS_RECOVERY_EVIDENCE (freshness/recovery NOT_RUN in this study)',
            'interpretation': 'B/A isolates the reader change; B/O includes index/cache/auth/admission changes. Three blocks are empirical evidence, not a significance claim.'}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('outcomes', type=Path)
    parser.add_argument('policy', type=Path)
    args = parser.parse_args()
    data = json.loads(args.outcomes.read_text(encoding='utf-8'))
    print(json.dumps(evaluate(data, json.loads(args.policy.read_text(encoding='utf-8'))), indent=2))
