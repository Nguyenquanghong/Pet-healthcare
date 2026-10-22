"""Offline review of cqrs-final-matched-kaggle-v1 results (data only, no execution).

  python benchmarks/phase2/kaggle/final_review.py check <result-dir>
  python benchmarks/phase2/kaggle/final_review.py combine <result-dir> [<result-dir> ...]

Same checks as list_review_v2.py (integrity, secret scan, stages, profileKey, policy
and overlay against the repo, per-member metrics and diagnostics), against the final
policy; only final-study sessions are accepted. combine keeps the first valid complete
attempt of each workload/block (two members, O and F) and grades with final_evaluate.
Not part of the notebook bundle.
"""
import argparse
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import list_review as v1  # noqa: E402
import list_review_v2 as r2  # noqa: E402
import final_evaluate as fe  # noqa: E402

STUDY = 'cqrs-final-matched-kaggle-v1'
v1.POLICY = v1.REPO / 'phase2-plan/cqrs/final/cqrs-final-matched-kaggle-v1.policy.json'
v1.ev = fe


def require_final(d):
    study = v1.load_json(Path(d) / 'summary.json').get('study')
    if study != STUDY:
        raise SystemExit(f'NOT_A_FINAL_SESSION: {d} ({study})')


def check(d, policy):
    require_final(d)
    out = v1.check(d, policy)
    for row in out['members']:
        row['diagnostics'] = r2.diagnostics(Path(d) / 'members' / row['id'])
    return out


def combine(dirs, policy):
    size = len(policy['blocksForEachWorkload'][0])
    blocks = {}
    for d in map(Path, dirs):
        require_final(d)
        if not v1.integrity(d)['ok']:
            raise SystemExit('INTEGRITY_FAILED: ' + str(d))
        for workload, entries in v1.load_json(d / 'all-trial-outcomes.json').items():
            for entry in entries:
                if entry['mode'] != 'full' or len(entry['records']) != size or any(r['status'] != 'COMPLETE' for r in entry['records']):
                    continue
                members = {r['configuration']: v1.member(d, r) for r in entry['records']}
                valid = all(fe.member_metrics(m, policy)['validity']['valid'] for m in members.values())
                key = (workload, entry['index'], entry['profileKeySha256'])
                # first valid complete attempt wins; an invalid replacement is still graded (and fails validity)
                if key not in blocks and (valid or entry['attempt'] == 1):
                    blocks[key] = {'index': entry['index'], 'profileKeySha256': entry['profileKeySha256'], 'members': members, 'session': d.name}
    workloads = {}
    for (workload, _, _), block in sorted(blocks.items()):
        workloads.setdefault(workload, []).append(block)
    result = fe.evaluate(workloads, policy) if workloads else {'decision': 'NOT_RUN'}
    result['sessions'] = sorted({b['session'] for b in blocks.values()})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('check').add_argument('dir')
    sub.add_parser('combine').add_argument('dirs', nargs='+')
    args = parser.parse_args()
    policy = v1.load_json(v1.POLICY)
    result = check(args.dir, policy) if args.command == 'check' else combine(args.dirs, policy)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
