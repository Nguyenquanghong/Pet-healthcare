"""cqrs-final-matched-kaggle-v1 member runner: list_trial.py with the O and F configurations.

list_trial.py (the v1 overlay, unchanged and copied next to this file) does all the
work; this entry point only narrows the accepted configurations to the two members
of the final study: O (pre-CQRS) and F (final product, projection maintenance off).
"""
import argparse
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import list_trial as base  # noqa: E402

CONFIGURATIONS = ('O', 'F')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workload', choices=['query-heavy', 'pcn'], required=True)
    parser.add_argument('--configuration', choices=list(CONFIGURATIONS), required=True)
    parser.add_argument('--mode', choices=['smoke', 'full'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--controller-pid', type=int, action='append', default=[])
    args = parser.parse_args(argv)
    args.output.mkdir(parents=True, exist_ok=False)
    runner = base.run_query if args.workload == 'query-heavy' else base.run_pcn
    report = runner(args.output, args.configuration, args.mode, args.ledger, args.controller_pid)
    print(json.dumps({'status': report['status'], 'failedStage': report.get('failedStage')}))
    return 0 if report['status'] == 'COMPLETE' else 1


if __name__ == '__main__':
    raise SystemExit(main())
