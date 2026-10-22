"""Grade cqrs-final-matched-kaggle-v1: the final product F against pre-CQRS O.

Members are measured and validated exactly as in the list study (list_evaluate:
query_member, pcn_member, member_metrics, pool_check, gate are reused unchanged;
F's expected read path is 'authoritative', O's is 'absent'). Only the comparison
changes: every gate is F/O non-regression with the thresholds frozen in the
policy's acceptance.finalNonRegressionAgainstO, all taken from the v1-v3 policy.
"""
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import list_evaluate as ev  # noqa: E402

CONFIGURATIONS = ('O', 'F')
# The controller reads members through this module (base.ev); measurement and validity are list_evaluate's.
query_member, pcn_member, member_metrics, pool_check = ev.query_member, ev.pcn_member, ev.member_metrics, ev.pool_check


def block_ratios(workload, metrics, policy):
    """metrics: {'O': m, 'F': m} of one complete block."""
    o, f = metrics['O'], metrics['F']
    p95 = lambda m, op: m['operations'].get(op, {}).get('p95Ms')
    enough = lambda m, op, n: m['operations'].get(op, {}).get('success', 0) >= n
    out = {}
    if workload == 'query-heavy':
        n = policy['queryHeavy']['minimumSuccessfulSamplesPerOperationPerRun']
        out['primaryFtoO'] = ev.ratio(p95(f, ev.PRIMARY), p95(o, ev.PRIMARY))
        out['primaryEnoughSamples'] = enough(o, ev.PRIMARY, n) and enough(f, ev.PRIMARY, n)
        out['calendarFtoO'] = {op: ev.ratio(p95(f, op), p95(o, op)) for op in ev.CALENDARS}
        out['calendarEnoughSamples'] = all(enough(m, op, n) for m in (o, f) for op in ev.CALENDARS)
        out['informational'] = {'everyOperationFtoO': {op: ev.ratio(p95(f, op), p95(o, op)) for op in sorted(o['operations'])}}
    else:
        n = policy['pcn']['minimumSuccessfulAppointmentWriteSamplesPerConfiguration']
        out['listFtoO'] = ev.ratio(p95(f, ev.PCN_LIST), p95(o, ev.PCN_LIST))
        out['writeFtoO'] = {op: ev.ratio(p95(f, op), p95(o, op)) for op in ev.PCN_WRITES}
        out['writeEnoughSamples'] = {op: enough(o, op, n) and enough(f, op, n) for op in ev.PCN_WRITES}
        out['informational'] = {'everyOperationFtoO': {op: ev.ratio(p95(f, op), p95(o, op)) for op in sorted(o['operations'])}}
    out['throughputFtoO'] = ev.ratio(f['successPerSecond'], o['successPerSecond'])
    out['cpuPerSuccessFtoO'] = ev.ratio(f['cpuPerSuccess'], o['cpuPerSuccess'])
    out['cpuComplete'] = o['cpu']['complete'] and f['cpu']['complete']
    return out


def evaluate_workload(workload, blocks, policy):
    """blocks: [{'index', 'profileKeySha256', 'members': {'O': member, 'F': member}}] in planned order."""
    acc = policy['acceptance']['finalNonRegressionAgainstO']
    result = {'workload': workload, 'blocks': [], 'gates': {}}
    complete = []
    for block in blocks:
        metrics = {c: ev.member_metrics(m, policy) for c, m in block['members'].items()}
        entry = {'index': block['index'], 'profileKeySha256': block['profileKeySha256'], 'members': metrics,
                 'pools': {c: ev.pool_check(block['members'][c]['report'].get('pool', {}).get('peaks', {}), c, policy) for c in metrics}}
        entry['complete'] = set(metrics) == set(CONFIGURATIONS) and all(m['status'] == 'COMPLETE' for m in metrics.values())
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
    if len(complete) < policy['acceptance']['matchedBlocksRequired'] or len(keys) != 1:
        result['status'] = 'INCONCLUSIVE_INSUFFICIENT_MATCHED_BLOCKS'
        return result
    r = [b['ratios'] for b in complete]
    cpu = ev.gate([x['cpuPerSuccessFtoO'] for x in r], every_max=acc['applicationCpuPerSuccessRatioMax'])
    if not all(x['cpuComplete'] for x in r):
        cpu = {'status': 'TOTAL_COST_INCONCLUSIVE', 'values': [x['cpuPerSuccessFtoO'] for x in r]}
    g['cpuPerSuccessFtoO'] = cpu
    g['throughputFtoO'] = ev.gate([x['throughputFtoO'] for x in r], every_min=acc['successfulThroughputRatioMin'])
    if workload == 'query-heavy':
        g['primaryFtoO'] = (ev.gate([x['primaryFtoO'] for x in r], every_max=acc['primaryListP95RatioMax'])
                            if all(x['primaryEnoughSamples'] for x in r) else {'status': 'INSUFFICIENT_SAMPLES'})
        g['calendarFtoO'] = {op: ev.gate([x['calendarFtoO'][op] for x in r], every_max=acc['calendarP95RatioMax'])
                             if all(x['calendarEnoughSamples'] for x in r) else {'status': 'INSUFFICIENT_SAMPLES'} for op in ev.CALENDARS}
    else:
        g['listFtoO'] = ev.gate([x['listFtoO'] for x in r], every_max=acc['pcnAppointmentListP95RatioMax'])
        g['writeFtoO'] = {op: ev.gate([x['writeFtoO'][op] for x in r], every_max=acc['writeP95RatioMax']) if all(x['writeEnoughSamples'][op] for x in r)
                          else {'status': 'INCONCLUSIVE_INSUFFICIENT_WRITE_SAMPLES'} for op in ev.PCN_WRITES}
    result['status'] = 'GRADED'
    return result


def decide(workloads, policy):
    """NO_REGRESSION only if both workloads are graded and every gate passes."""
    by = {w['workload']: w for w in workloads}
    if any(w['gates'].get('correctness') == 'FAIL' for w in workloads):
        return 'FAIL_CORRECTNESS'
    if any(w['gates'].get('environment') == 'INVALID_ENVIRONMENT' for w in workloads):
        return 'INVALID_ENVIRONMENT'
    if set(by) != {'query-heavy', 'pcn'} or any(w['status'] != 'GRADED' for w in workloads):
        return 'INCONCLUSIVE'
    statuses = [s for w in workloads for _, s in ev.flatten(w['gates'])]
    if 'FAIL' in statuses:
        return 'REGRESSION'
    if any(s not in ('PASS', 'VALID') for s in statuses):
        return 'INCONCLUSIVE'
    return 'NO_REGRESSION'


def evaluate(workloads, policy):
    graded = [evaluate_workload(w, blocks, policy) for w, blocks in workloads.items()]
    return {'study': policy['study'], 'policyVersion': policy['version'], 'workloads': graded, 'decision': decide(graded, policy),
            'interpretation': 'F/O compares the final product with the pre-CQRS source; it includes every change since 3e88d7e, '
                              'not only the CQRS switch. Three blocks are empirical evidence, not a significance claim.'}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('outcomes', type=Path)
    parser.add_argument('policy', type=Path)
    args = parser.parse_args()
    data = json.loads(args.outcomes.read_text(encoding='utf-8'))
    print(json.dumps(evaluate(data, json.loads(args.policy.read_text(encoding='utf-8'))), indent=2))
