"""Freeze uncommitted Q6 source without checkout, commit, build or DB access.

O is read from Git objects; A and B share one byte-identical worktree snapshot.
The separate measurement harness is identical for all configurations. This is
a build/runtime source package, not a backup of the whole development repo.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

REPO = Path(__file__).resolve().parents[3]
BASELINE = '3e88d7e57fbf4f74da363d320f286244237a4389'
POLICY_SHA = '4a58f33788f9014df21ceb5d4fa86869e2894dbe4e4b09e374e48e68d6ec3921'
FORMAT = 'cqrs-q6-source-v1'
ROOTS = ('backend', 'frontend', 'services/clinic', 'services/notification',
         'packages/contracts', 'packages/messaging', 'packages/runtime', 'tools/vendor/braces')
BUILD_TOOLS = ('tools/phase2/copy-client.mjs', 'tools/phase2/copy-core-client.mjs')
TOP = ('package.json', 'package-lock.json', *BUILD_TOOLS)
HARNESS = (
    'benchmarks/phase2/dataset.mjs',
    *('benchmarks/phase2/kaggle/' + name for name in (
        'native_stack.py', 'stack.mjs', 'benchmark.py', 'acceptance.json',
        'query_heavy.py', 'query_dataset.mjs', 'pcn_runner.py', 'pcn_adapter.py',
        'pcn_dataset.mjs', 'pcn_locust.py', 'cqrs_source.py', 'cqrs_runtime.mjs', 'cqrs_probe.py', 'cqrs_benchmark.py', 'cqrs_diagnostics.py', 'cqrs_query_plans.mjs')),
    *('benchmarks/kaggle/' + name for name in ('pcn_locustfile.py', 'pcn_contract.py', 'metrics.py')),
)
EXTENSIONS = {'.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.prisma', '.sql',
              '.toml', '.css', '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2'}
DENIED_PARTS = {'.git', '.aws', '.codex', '.agents', 'node_modules', 'dist', 'generated',
                'test-results', 'playwright-report', 'uploads', '__pycache__', 'coverage'}
MAX_BYTES = 64 * 1024 * 1024


def require(condition, code):
    if not condition:
        raise ValueError('Q6_SOURCE_' + code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def lf(data):
    return data.replace(b'\r\n', b'\n')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def safe_path(name):
    require(isinstance(name, str) and 0 < len(name) <= 240, 'PATH')
    require(not any(c in name for c in ('\\', ':', '\0')) and not name.startswith('/'), 'PATH')
    require(all(p not in ('', '.', '..') and not p.endswith((' ', '.')) for p in name.split('/')), 'PATH')
    # Reject Windows device names even when extracting on Linux.
    require(all(not re.fullmatch(r'(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])', p.split('.')[0], re.I)
                for p in name.split('/')), 'PATH')
    return name


def selected(name):
    safe_path(name)
    path = PurePosixPath(name)
    parts = [p.lower() for p in path.parts]
    if any(p in DENIED_PARTS or p.startswith('.env') for p in parts):
        return False
    if path.name in ('vite.config.js', 'vite.config.d.ts'):
        return False
    return (name in TOP or any(name.startswith(root + '/') for root in ROOTS)) and (
        path.suffix in EXTENSIONS or path.name in ('LICENSE', 'LICENSE.md', 'NOTICE'))


def linked(path):
    # Path.is_junction arrived in Python 3.12; Kaggle may still run 3.11.
    return path.is_symlink() or getattr(path, 'is_junction', lambda: False)()


def source_bytes(root, name):
    safe_path(name)
    root = root.resolve(strict=True)
    path = root / name
    # Reject parent symlinks/junctions too; source must be a normal local file.
    for parent in (path, *path.parents):
        if parent == root:
            break
        require(not linked(parent), 'LINK')
    require(path.resolve(strict=True).is_relative_to(root) and path.is_file(), 'FILE')
    data = path.read_bytes()
    require(len(data) <= MAX_BYTES, 'SIZE')
    # Never print a matching value or file contents on failure.
    require(not re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', data), 'PRIVATE_KEY')
    require(not re.search(rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})', data), 'CREDENTIAL')
    return data


def git(root, *args, input=None):
    try:
        return subprocess.check_output(['git', '-C', str(root), *args], input=input, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError:
        raise ValueError('Q6_SOURCE_GIT_FAILED') from None


def entries(files):
    return [{'path': p, 'bytes': len(b), 'sha256': digest(b)} for p, b in sorted(files.items())]


def snapshot(files):
    rows = entries(files)
    return {'sha256': digest(canonical(rows)), 'files': rows}


def baseline_files(root):
    # Read blobs directly: git archive may apply autocrlf/export attributes.
    tree = git(root, 'ls-tree', '-r', '-z', BASELINE, '--', *ROOTS, *TOP)
    objects = []
    for record in tree.split(b'\0'):
        if not record:
            continue
        metadata, name = record.split(b'\t', 1)
        mode, kind, oid = metadata.split(b' ')
        name = name.decode('utf-8')
        if selected(name):
            require(mode in (b'100644', b'100755') and kind == b'blob', 'GIT_FILE_TYPE')
            objects.append((name, oid))
    data = git(root, 'cat-file', '--batch', input=b''.join(oid + b'\n' for _, oid in objects))
    result, offset = {}, 0
    for name, oid in objects:
        end = data.index(b'\n', offset)
        actual_oid, kind, size = data[offset:end].split(b' ')
        size = int(size)
        require(actual_oid == oid and kind == b'blob' and 0 <= size <= MAX_BYTES, 'GIT_BLOB')
        offset = end + 1
        result[name] = data[offset:offset + size]
        require(len(result[name]) == size and data[offset + size:offset + size + 1] == b'\n', 'GIT_BLOB')
        offset += size + 1
    require(offset == len(data), 'GIT_BLOB')
    require(result, 'EMPTY_BASELINE')
    return result


def worktree_files(root):
    names = git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', *ROOTS, *TOP)
    result = {}
    for name in sorted(set(names.decode('utf-8').split('\0')) - {''}):
        if selected(name):
            require(not linked(root / name), 'LINK')
            if (root / name).exists():
                result[name] = source_bytes(root, name)
    require(result, 'EMPTY_WORKTREE')
    return result


def make_plan(policy, sources):
    b = policy['benchmark']
    require(b['order'] == ['AB', 'BA', 'AB'] and b['abPairsMin'] == 3, 'POLICY_ORDER')
    trials = []
    for workload in ('query-heavy', 'pcn'):
        trials.extend({'workload': workload, 'name': 'smoke-' + mode, 'configuration': mode,
                       'phase': 'smoke', 'pair': None} for mode in 'OAB')
        trials.extend({'workload': workload, 'name': f'O-{n}', 'configuration': 'O',
                       'phase': 'full', 'pair': None} for n in range(1, 4))
        for n, order in enumerate(b['order'], 1):
            trials.extend({'workload': workload, 'name': f'pair-{n}-{mode}', 'configuration': mode,
                           'phase': 'full', 'pair': n} for mode in order)
    return {
        'status': 'NOT_RUN', 'capacity_accepted': False, 'policy_sha256': POLICY_SHA,
        'sequential': True, 'automatic_retries': False,
        'configurations': {mode: {'source_sha256': sources['O' if mode == 'O' else 'AB']['sha256'],
                                  'read_mode': 'projection' if mode == 'B' else 'authoritative',
                                  'projector_enabled': mode != 'O', 'shadow_enabled': False}
                           for mode in 'OAB'},
        'query_heavy': {'appointments': 100000, 'warmup_seconds': 120, 'steady_seconds': 800,
                        'rate': 12, 'concurrency': 16, 'samples_per_operation': 1200,
                        'operations': 8, 'clinic_replicas': 1},
        'pcn': b['pcn'], 'trials': trials,
        'execution_requirements': ['fresh marked UUID trial for each entry',
            'same fixture shape/seed, auth, limiter, timeout, replicas and pools',
            'A and B run producer and projector; B must prove projected reads',
            'all API/worker/PG/Rabbit/Redis/nginx/generator resources counted',
            'equal enforced total resource budget required for acceptance',
            'stop at first failed smoke or trial, retain raw errors and dropped arrivals'],
    }


def make_bundle(root, output):
    root, output = Path(root).resolve(strict=True), Path(output).absolute()
    require(Path(git(root, 'rev-parse', '--show-toplevel').decode().strip()).resolve() == root, 'ROOT')
    head = git(root, 'rev-parse', 'HEAD').decode().strip()
    require(head == BASELINE, 'HEAD_CHANGED_REVIEW_BASELINE')
    require(not output.exists(), 'OUTPUT_EXISTS')
    policy = source_bytes(root, 'phase2-plan/cqrs/acceptance.json')
    require(digest(policy) == POLICY_SHA, 'POLICY_DRIFT')
    original, current = baseline_files(root), worktree_files(root)
    require(lf(original['package-lock.json']) == lf(current['package-lock.json']), 'LOCKFILE_DRIFT')
    require('services/clinic/src/readWorker.ts' in current and 'services/clinic/src/readWorker.ts' not in original, 'CQRS_SOURCE')
    helpers = {name: source_bytes(root, name) for name in HARNESS}
    sources = {'O': snapshot(original), 'AB': snapshot(current), 'harness': snapshot(helpers)}
    changes = [{'path': name, 'change': 'added' if name not in original else 'deleted' if name not in current else
                'line_endings_only' if lf(original[name]) == lf(current[name]) else 'modified'}
               for name in sorted(original.keys() | current.keys()) if original.get(name) != current.get(name)]
    plan = make_plan(json.loads(policy), sources)
    payload = {f'{group}/{name}': data for group, files in [('O', original), ('AB', current), ('harness', helpers)]
               for name, data in files.items()}
    payload.update({'policy.json': policy, 'plan.json': canonical(plan) + b'\n'})
    manifest = {'format': FORMAT, 'baseline_git_sha': BASELINE, 'worktree_head': head,
                'sources': sources, 'changes_from_O': changes, 'files': entries(payload),
                'scope': 'Build/runtime source only; no .git/env/keys/uploads/generated/dependencies/results. '
                         'O committed bytes; AB current tracked and untracked source; shared harness overlay.',
                'validation': 'SOURCE_INTEGRITY_ONLY', 'measurements': 'NOT_RUN'}
    manifest['lockfile_equivalence'] = 'Identical after CRLF-to-LF normalization; original bytes and separate hashes retained'
    manifest['sha256'] = digest(canonical(manifest))
    payload['manifest.json'] = canonical(manifest) + b'\n'
    # Catch changes during collection before publishing the package.
    require(current == worktree_files(root), 'WORKTREE_CHANGED_DURING_PACK')
    require(all(source_bytes(root, name) == data for name, data in helpers.items()), 'HARNESS_CHANGED_DURING_PACK')
    require(source_bytes(root, 'phase2-plan/cqrs/acceptance.json') == policy and
            git(root, 'rev-parse', 'HEAD').decode().strip() == head, 'PROVENANCE_CHANGED_DURING_PACK')
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, 'x', ZIP_DEFLATED) as archive:
        for name, data in sorted(payload.items()):
            info = ZipInfo(name, date_time=(2026, 10, 16, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            archive.writestr(info, data)
    result = verify_bundle(output)
    return {'archive': str(output), **result}


def read_bundle(path, expected_sha=None):
    path = Path(path)
    require(path.stat().st_size <= MAX_BYTES, 'ARCHIVE_SIZE')
    raw = path.read_bytes()
    archive_sha = digest(raw)
    require(expected_sha is None or expected_sha == archive_sha, 'ARCHIVE_HASH')
    with ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        require(0 < len(infos) <= 10000 and sum(i.file_size for i in infos) <= MAX_BYTES, 'ARCHIVE_SIZE')
        names = set()
        for info in infos:
            safe_path(info.filename)
            require(info.filename.casefold() not in names, 'DUPLICATE_PATH')
            names.add(info.filename.casefold())
            require(not info.is_dir() and stat.S_ISREG(info.external_attr >> 16), 'ARCHIVE_FILE_TYPE')
        payload = {i.filename: archive.read(i) for i in infos}
    manifest = json.loads(payload.pop('manifest.json'))
    expected_manifest = manifest.pop('sha256')
    require(digest(canonical(manifest)) == expected_manifest, 'MANIFEST_HASH')
    require(manifest['format'] == FORMAT and manifest['baseline_git_sha'] == BASELINE
            and manifest['worktree_head'] == BASELINE, 'FORMAT')
    require(entries(payload) == manifest['files'], 'FILE_HASH_OR_INVENTORY')
    require(digest(payload['policy.json']) == POLICY_SHA, 'POLICY_DRIFT')
    require(set(manifest['sources']) == {'O', 'AB', 'harness'}, 'SOURCE_GROUPS')
    for group, descriptor in manifest['sources'].items():
        files = {name[len(group) + 1:]: data for name, data in payload.items() if name.startswith(group + '/')}
        require(files and snapshot(files) == descriptor, 'SOURCE_HASH')
        require(all((name in HARNESS if group == 'harness' else selected(name)) for name in files), 'SOURCE_SCOPE')
    require(all(name in ('plan.json', 'policy.json') or name.split('/')[0] in manifest['sources'] for name in payload), 'PAYLOAD_SCOPE')
    plan = json.loads(payload['plan.json'])
    require(plan == make_plan(json.loads(payload['policy.json']), manifest['sources']), 'PLAN_DRIFT')
    require(lf(payload['O/package-lock.json']) == lf(payload['AB/package-lock.json']), 'LOCKFILE_DRIFT')
    manifest['sha256'] = expected_manifest
    payload['manifest.json'] = canonical(manifest) + b'\n'
    return payload, manifest, archive_sha


def verify_bundle(path, expected_sha=None):
    _, manifest, archive_sha = read_bundle(path, expected_sha)
    return {'status': 'SOURCE_INTEGRITY_VERIFIED', 'archive_sha256': archive_sha,
            'manifest_sha256': manifest['sha256'], 'baseline_git_sha': BASELINE,
            'sources': {group: {'sha256': value['sha256'], 'files': len(value['files'])}
                        for group, value in manifest['sources'].items()},
            'measurements': 'NOT_RUN', 'capacity_accepted': False}


def extract_bundle(path, destination, expected_sha):
    # Hash+inventory+all paths validated before creating anything. Never extractall.
    payload, manifest, archive_sha = read_bundle(path, expected_sha)
    destination = Path(destination).absolute()
    require(not destination.exists() and not destination.is_symlink(), 'DESTINATION_EXISTS')
    require(destination.parent.is_dir(), 'DESTINATION_PARENT')
    for parent in (destination.parent, *destination.parent.parents):
        require(not linked(parent), 'DESTINATION_LINK')
    # Python 3.13 applies a special Windows ACL for 0700 which conflicts with
    # restricted-token workspaces. Inherit the workspace ACL on Windows.
    destination.mkdir(mode=0o777 if os.name == 'nt' else 0o700)
    for name, data in payload.items():
        target = destination / safe_path(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as handle:
            handle.write(data)
        require(digest(target.read_bytes()) == digest(data), 'EXTRACTED_HASH')
    return {'status': 'EXTRACTED_AND_VERIFIED', 'directory': str(destination),
            'archive_sha256': archive_sha, 'manifest_sha256': manifest['sha256'], 'measurements': 'NOT_RUN'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    pack = commands.add_parser('pack', help='Create a new O/AB/harness ZIP; no commit or DB access')
    pack.add_argument('--output', type=Path, required=True)
    for name in ('verify', 'extract'):
        command = commands.add_parser(name)
        command.add_argument('archive', type=Path)
        command.add_argument('--sha256', required=True, help='Expected ZIP hash from pack/receipt')
        if name == 'extract':
            command.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'pack':
            result = make_bundle(REPO, args.output)
        elif args.command == 'verify':
            result = verify_bundle(args.archive, args.sha256)
        else:
            result = extract_bundle(args.archive, args.destination, args.sha256)
        print(json.dumps(result))
    except Exception as error:
        # No raw Git/process/archive errors: they may contain private paths/data.
        code = str(error) if re.fullmatch(r'Q6_SOURCE_[A-Z_]+', str(error)) else 'Q6_SOURCE_FAILED'
        print(json.dumps({'status': 'FAIL', 'code': code, 'measurements': 'NOT_RUN'}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
