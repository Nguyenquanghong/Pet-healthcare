"""Q6 O/A/B trials from a verified source package. Linux native stack only.

Default: smoke O, A, B. --full additionally runs O x3 then AB, BA, AB.
No automatic retry, no production target, no capacity/deployment acceptance.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import time
from uuid import uuid4

from cqrs_source import REPO, HARNESS, digest, read_bundle, extract_bundle


def clean_env():
    return {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'TMPDIR', 'SystemRoot')}


def prepare(archive, sha):
    payload, manifest, actual_sha = read_bundle(archive, sha)
    # Prevent a different checkout's runner or helper silently measuring this bundle.
    for name in HARNESS:
        if payload['harness/' + name] != (REPO / name).read_bytes():
            raise ValueError('Q6_RUNNING_HARNESS_DIFFERS_FROM_BUNDLE')
    destination = Path('/tmp') / ('pet-cqrs-q6-source-' + str(uuid4()))
    extract_bundle(archive, destination, actual_sha)
    roots = {key: destination / key for key in ('O', 'AB')}
    for group, root in roots.items():
        for name in HARNESS:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as handle:
                handle.write(payload['harness/' + name])
        for step, args in [('install', ['npm', 'ci', '--no-audit', '--no-fund']), ('build', ['npm', 'run', 'phase2:build'])]:
            print(f'Q6 {group}: {step}; private setup log retained', flush=True)
            with (destination / (group + '-' + step + '.log')).open('wb') as log:
                result = subprocess.run(args, cwd=root, env=clean_env(), stdout=log, stderr=subprocess.STDOUT, timeout=600)
            if result.returncode:
                raise RuntimeError('Q6_BUILD_FAILED')
        for row in manifest['sources'][group]['files']:
            if digest((root / row['path']).read_bytes()) != row['sha256']:
                raise RuntimeError('Q6_SOURCE_CHANGED_DURING_BUILD')
        for name in HARNESS:
            if (root / name).read_bytes() != payload['harness/' + name]:
                raise RuntimeError('Q6_HARNESS_CHANGED_DURING_BUILD')
    return roots, json.loads(payload['plan.json']), manifest


def trial(root, output, item):
    command = [sys.executable, str(root / 'benchmarks/phase2/kaggle/cqrs_benchmark.py'), 'trial',
               '--output', str(output), '--workload', item['workload'],
               '--configuration', item['configuration'], '--mode', item['phase']]
    # stdout is private too; only our bounded progress message is exported.
    with (root.parent / (item['workload'] + '-' + item['name'] + '.log')).open('wb') as log:
        process = subprocess.Popen(command, cwd=root, env=clean_env(), stdout=log, stderr=subprocess.STDOUT)
        started = time.monotonic()
        try:
            while True:
                try:
                    code = process.wait(timeout=30)
                    break
                except subprocess.TimeoutExpired:
                    elapsed = time.monotonic() - started
                    print(f"Q6 {item['workload']} {item['name']}: {int(elapsed)}s; no retries", flush=True)
                    if elapsed > 3600:
                        raise TimeoutError('Q6_TRIAL_DEADLINE')
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
                try: process.wait(timeout=45)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=10)
    if code:
        return {'status': 'FAIL', 'exit_code': code}
    if item['workload'] == 'query-heavy':
        report = json.loads((output / 'report.json').read_text())
        return {'status': report['status'], 'run': report.get('run')}
    report = json.loads((output / 'pcn-report.json').read_text())
    manifest = json.loads((output / 'manifest.json').read_text())
    # Smoke is not full PCN acceptance. Require real requests, zero failure and
    # reconciliation, as well as actual path preflight and clean teardown.
    load = json.loads((output / 'load-final.json').read_text())
    good = manifest['status'] == 'COMPLETE' and report['load_status'] != 'FAIL'
    good = good and load.get('requests', 0) > 0
    good = good and (load.get('failures') == 0 if item['phase'] == 'smoke' else report['load_status'] == 'PASS_IN_SCOPE')
    return {'status': ('SMOKE_PASS' if item['phase'] == 'smoke' else 'BENCHMARK_RUN_RECORDED') if good else 'FAIL',
            'run': manifest.get('run'), 'pcn_load_status': report['load_status']}


def matrix(roots, output, plan, *, workload, full=False, dispatch=trial):
    if workload not in ('query-heavy', 'pcn'):
        raise ValueError('Q6_WORKLOAD')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    report = {'status': 'STARTING', 'workload': workload, 'full': full, 'trials': [],
              'capacity_accepted': False, 'deployment_accepted': False,
              'equal_total_budget': 'UNVERIFIED', 'decision': 'INCONCLUSIVE'}
    try:
        for item in plan['trials']:
            if item['workload'] != workload or not full and item['phase'] != 'smoke':
                continue
            root = roots['O' if item['configuration'] == 'O' else 'AB']
            result = dispatch(root, output / item['name'], item)
            report['trials'].append({**item, **result})
            (output / 'workflow.json').write_text(json.dumps(report, indent=2))
            expected = 'SMOKE_PASS' if item['phase'] == 'smoke' else 'BENCHMARK_RUN_RECORDED'
            if result['status'] != expected:
                report['status'] = 'STOPPED'
                break
        else:
            report['status'] = 'MEASUREMENTS_RECORDED' if full else 'SMOKE_ONLY'
    except Exception as error:
        report.update(status='STOPPED', error_type=type(error).__name__)
    (output / 'workflow.json').write_text(json.dumps(report, indent=2))
    return report


def run(archive, sha, output, *, workload, full=False):
    output = Path(output).absolute()
    output.mkdir(parents=True, exist_ok=False)
    report = {'status': 'STARTING', 'measurements': 'NOT_RUN', 'capacity_accepted': False}
    stage = 'environment'
    try:
        if platform.system() != 'Linux':
            raise RuntimeError('Q6_REQUIRES_LINUX_NATIVE_STACK')
        stage = 'source-and-build'
        roots, plan, manifest = prepare(archive, sha)
        (output / 'environment.json').write_text(json.dumps({'source_archive_sha256': sha,
            'source_manifest_sha256': manifest['sha256'], 'sources': manifest['sources'],
            'policy_sha256': plan['policy_sha256'], 'plan': plan, 'capacity_accepted': False}, indent=2))
        stage = 'trials'
        report = matrix(roots, output / 'trials', plan, workload=workload, full=full)
    except Exception as error:
        report.update(status='INVALID_ENVIRONMENT' if stage == 'environment' else 'STOPPED',
                      failed_stage=stage, error_type=type(error).__name__)
    (output / 'run.json').write_text(json.dumps(report, indent=2))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    run_parser = commands.add_parser('run')
    run_parser.add_argument('--bundle', type=Path, required=True)
    run_parser.add_argument('--sha256', required=True)
    run_parser.add_argument('--full', action='store_true')
    trial_parser = commands.add_parser('trial', help='Internal isolated child; no external DB target accepted')
    trial_parser.add_argument('--configuration', choices=['O', 'A', 'B'], required=True)
    trial_parser.add_argument('--mode', choices=['smoke', 'full'], required=True)
    for p in (run_parser, trial_parser):
        p.add_argument('--output', type=Path, required=True)
        p.add_argument('--workload', choices=['query-heavy', 'pcn'], required=True)
    args = parser.parse_args()
    try:
        if args.command == 'run':
            result = run(args.bundle, args.sha256, args.output, workload=args.workload, full=args.full)
        elif args.workload == 'query-heavy':
            from query_heavy import run_trial
            result = run_trial(REPO, args.output, mode=args.mode, cqrs_configuration=args.configuration)
        else:
            from pcn_runner import run_pcn
            result = run_pcn(REPO, args.output, mode=args.mode, cqrs_configuration=args.configuration)
        print(json.dumps({'status': result.get('status', result.get('load_status')), 'capacity_accepted': False}))
        if result.get('status') in ('STOPPED', 'FAIL', 'INVALID_ENVIRONMENT') or result.get('load_status') == 'FAIL':
            return 1
        return 0
    except Exception as error:
        print(json.dumps({'status': 'FAIL', 'error_type': type(error).__name__}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
