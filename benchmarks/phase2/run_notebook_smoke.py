"""Execute every notebook code cell with a bounded four-profile screening config."""
import json
import argparse
import os
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--steady-seconds', type=int, default=5)
parser.add_argument('--users', type=int, default=2)
parser.add_argument('--max-requests', type=int, default=100)
parser.add_argument('--accounts', type=int, default=8)
args = parser.parse_args()
if not (1 <= args.steady_seconds <= 60 and 1 <= args.users <= 10 and 1 <= args.max_requests <= 2000 and 1 <= args.accounts <= 40):
    parser.error('Screening bounds: 1-60 seconds, 1-10 users, 1-2000 requests per segment.')

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')
root = Path(__file__).resolve().parents[2]
os.chdir(root)
os.environ['MPLBACKEND'] = 'Agg'
os.environ['MPLCONFIGDIR'] = str(root / 'test-results/phase2/matplotlib')
notebook = json.loads(Path(__file__).with_name('phase2-load.ipynb').read_text(encoding='utf-8'))
namespace = {'__name__': '__main__'}
for index, cell in enumerate(notebook['cells']):
    if cell['cell_type'] != 'code':
        continue
    source = ''.join(cell['source'])
    print(f'Executing notebook code cell {index}', flush=True)
    exec(compile(source, f'phase2-load.ipynb:cell-{index}', 'exec'), namespace)
    if source.startswith("MODE = 'smoke'"):
        namespace.update(PROFILES=['read', 'clinic_write', 'mixed', 'login_policy'],
                         CONCURRENCY=[args.users], WARMUP_SECONDS=1, STEADY_SECONDS=args.steady_seconds,
                         MAX_REQUESTS=args.max_requests, REPEATS=1, ALLOW_WRITES=True, ACCOUNTS=args.accounts)
        print(f'Smoke override: four profiles, {args.users} VU, 1s warmup + {args.steady_seconds}s steady, cap={args.max_requests} per segment', flush=True)
reports = namespace['reports']
assert len(reports) == 4
assert all(report['completed_requests'] > 0 and not report['capacity_accepted'] for report in reports)
assert all(report['reconciliation']['status'] == 'PASS_IN_SCOPE' for report in reports if report['profile'] in ('clinic_write', 'mixed'))
for report in reports:
    metrics = json.loads((Path(report['directory']) / 'metrics.json').read_text(encoding='utf-8'))
    assert {m['service'] for m in metrics if m['http_status'] == 200 and 'pet_rss_bytes' in m} == {'core', 'clinic', 'notification'}
    if report['profile'] != 'login_policy':
        assert all(row['unexpected_error_rate'] == 0 for row in report['summary']), report['profile']
print('NOTEBOOK_EXECUTION_PASS: four profiles, write reconciliation checked; SCREENING only', flush=True)
