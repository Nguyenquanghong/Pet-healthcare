"""Offline review of cqrs-list-matched-kaggle-v1 Kaggle results (data only, no execution).

  python benchmarks/phase2/kaggle/list_review.py check <result-dir>
      integrity (result-manifest), secret scan, summary/stages/readiness, profileKey,
      overlay vs repo, per-member metrics.
  python benchmarks/phase2/kaggle/list_review.py combine <result-dir> [<result-dir> ...]
      collect full-mode blocks from one or more sessions (first valid complete
      attempt per workload/block), then grade with list_evaluate.evaluate. Blocks
      with different profileKeys are kept and reported; acceptance needs 3 blocks
      under one key per workload.
Result dirs are extracted exports (cqrs-list-<run>/). Not part of the notebook bundle.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))
import list_evaluate as ev  # noqa: E402

POLICY = REPO / 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v1.policy.json'
SECRET = re.compile(r'(postgresql|amqp|redis)://|BEGIN (RSA )?PRIVATE KEY|"password"|Bearer [A-Za-z0-9]')


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def load_lines(path):
    path = Path(path)
    return [json.loads(l) for l in path.read_text(encoding='utf-8').splitlines() if l.strip()] if path.is_file() else []


def integrity(d):
    manifest = load_json(d / 'result-manifest.json')
    listed = {e['path'] for e in manifest['files']}
    present = {p.relative_to(d).as_posix() for p in d.rglob('*') if p.is_file()} - {'result-manifest.json'}
    bad = [e['path'] for e in manifest['files'] if not (d / e['path']).is_file()
           or hashlib.sha256((d / e['path']).read_bytes()).hexdigest() != e['sha256'] or (d / e['path']).stat().st_size != e['bytes']]
    secrets = [p for p in sorted(present) if SECRET.search((d / p).read_text(encoding='utf-8', errors='replace'))]
    return {'files': len(manifest['files']), 'unlisted': sorted(present - listed), 'missing': sorted(listed - present),
            'hashMismatch': bad, 'secretHits': secrets, 'ok': not (present - listed or listed - present or bad or secrets)}


def member(d, record):
    m = d / record['dir']
    return {'workload': record['workload'], 'configuration': record['configuration'], 'report': load_json(m / 'member-report.json'),
            'rows': load_lines(m / 'requests.jsonl'), 'probe': load_lines(m / 'event-loop-probe.jsonl'), 'cpu': load_json(m / 'cpu-window.json')}


def check(d, policy):
    d = Path(d)
    out = {'dir': str(d), 'integrity': integrity(d), 'summary': load_json(d / 'summary.json'),
           'stages': [(s['stage'], s['status']) for s in load_json(d / 'stages.json')]}
    if (d / 'readiness.json').is_file():
        out['readiness'] = load_json(d / 'readiness.json')
    plan = load_json(d / 'plan-and-hashes.json')
    out['profileKeySha256'] = plan['profileKeySha256']
    out['policyMatchesRepo'] = plan['policySha256'] == hashlib.sha256(POLICY.read_bytes()).hexdigest()
    out['overlayMatchesRepo'] = {n: hashlib.sha256((REPO / n).read_bytes()).hexdigest() == v for n, v in plan['overlay'].items()}
    out['buildNormalized'] = {g: b['normalized'] for g, b in plan['builds'].items()}
    members = []
    for workload, entries in load_json(d / 'all-trial-outcomes.json').items():
        for entry in entries:
            for record in entry['records']:
                if not (d / record['dir'] / 'member-report.json').is_file():
                    members.append({'id': record['id'], 'status': record['status'], 'failedStage': record.get('failedStage')}); continue
                x = ev.member_metrics(member(d, record), policy)
                members.append({'id': record['id'], 'mode': entry['mode'], 'attempt': entry['attempt'], 'status': record['status'],
                                'correct': x['correct'], 'valid': x['validity']['valid'], 'reasons': x['validity']['reasons'],
                                'errors': x['errors'], 'pathErrors': x.get('pathErrors'), 'fallbacks': x.get('listFallbacks'),
                                'cpuComplete': x['cpu']['complete'], 'cpuReasons': x['cpu']['reasons'], 'successes': x['successes']})
    out['members'] = members
    return out


def combine(dirs, policy):
    blocks = {}
    for d in map(Path, dirs):
        if not integrity(d)['ok']:
            raise SystemExit('INTEGRITY_FAILED: ' + str(d))
        for workload, entries in load_json(d / 'all-trial-outcomes.json').items():
            for entry in entries:
                if entry['mode'] != 'full' or len(entry['records']) != 3 or any(r['status'] != 'COMPLETE' for r in entry['records']):
                    continue
                members = {r['configuration']: member(d, r) for r in entry['records']}
                valid = all(ev.member_metrics(m, policy)['validity']['valid'] for m in members.values())
                key = (workload, entry['index'], entry['profileKeySha256'])
                # first valid complete attempt wins; an invalid replacement is still graded (and fails validity)
                if key not in blocks and (valid or entry['attempt'] == 1):
                    blocks[key] = {'index': entry['index'], 'profileKeySha256': entry['profileKeySha256'], 'members': members, 'session': d.name}
    workloads = {}
    for (workload, _, _), block in sorted(blocks.items()):
        workloads.setdefault(workload, []).append(block)
    result = ev.evaluate(workloads, policy) if workloads else {'decision': 'NOT_RUN'}
    result['sessions'] = sorted({b['session'] for b in blocks.values()})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('check').add_argument('dir')
    sub.add_parser('combine').add_argument('dirs', nargs='+')
    args = parser.parse_args()
    policy = load_json(POLICY)
    result = check(args.dir, policy) if args.command == 'check' else combine(args.dirs, policy)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
