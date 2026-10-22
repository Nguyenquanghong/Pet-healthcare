"""Offline review of cqrs-list-matched-kaggle-v2 results (data only, no execution).

Same commands as list_review.py (check / combine), against the v2 policy. Adds:
- every session must be a v2 session (summary.study), so v1 and v2 blocks are
  never graded together;
- a per-member diagnostics summary (outbox backlog, projected-read failure
  reasons, Postgres checkpoints/errors) from the v2 sampler files. Diagnostic
  only: grading is list_evaluate.evaluate exactly as in v1.
Not part of the notebook bundle.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import list_review as v1  # noqa: E402

STUDY = 'cqrs-list-matched-kaggle-v2'
v1.POLICY = v1.REPO / 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v2.policy.json'


def require_v2(d):
    study = v1.load_json(Path(d) / 'summary.json').get('study')
    if study != STUDY:
        raise SystemExit(f'NOT_A_V2_SESSION: {d} ({study})')


def diagnostics(member_dir):
    m = Path(member_dir)
    samples = [s for s in v1.load_lines(m / 'diagnostics.jsonl') if 'monotonicMs' in s]
    if not samples:
        return {'present': False}
    pending = lambda key: [s[key]['pending'] for s in samples if s.get(key)]
    reads = v1.load_lines(m / 'clinic-read-diagnostics.jsonl')
    failures = Counter(f"{r.get('stage')}:{r.get('reason')}:{r.get('sqlState')}" for r in reads if r.get('event') == 'projection_failure')
    pg = [r.get('line', '') for r in v1.load_lines(m / 'postgres-log.jsonl')]
    # The sampler's own outbox query fails until migrations create "OutboxEvent"
    # (first ~20 s of a stack, before any measured window); count it apart.
    own = {i for i, l in enumerate(pg) if 'STATEMENT:' in l and "json_build_object('pending'" in l}
    own |= {i - 1 for i in own if i > 0 and 'relation "OutboxEvent" does not exist' in pg[i - 1]}
    sampler_pg = len(own) // 2
    pg = [l for i, l in enumerate(pg) if i not in own]
    stopped = [s for s in v1.load_lines(m / 'diagnostics.jsonl') if s.get('event') == 'sampler-stopped']
    return {'present': True, 'samples': len(samples), 'samplerErrors': stopped[-1]['errors'] if stopped else None,
            'clinicOutboxPendingMax': max(pending('clinicOutbox'), default=None), 'coreOutboxPendingMax': max(pending('coreOutbox'), default=None),
            'projectionFailures': dict(failures.most_common(10)), 'fallbacks': sum(1 for r in reads if r.get('event') == 'fallback_ok'),
            'checkpoints': sum('checkpoint complete' in l for l in pg), 'pgErrors': sum('ERROR:' in l for l in pg),
            'samplerStartupPgErrors': sampler_pg,
            'statementTimeouts': sum('statement timeout' in l for l in pg)}


def check(d, policy):
    require_v2(d)
    out = v1.check(d, policy)
    for row in out['members']:
        row['diagnostics'] = diagnostics(Path(d) / 'members' / row['id'])
    return out


def combine(dirs, policy):
    for d in dirs:
        require_v2(d)
    return v1.combine(dirs, policy)


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
