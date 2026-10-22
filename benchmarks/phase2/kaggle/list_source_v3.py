"""Pack the O/AB/harness source bundle for cqrs-list-matched-kaggle-v3.

Same format, reader and E-b exclusion as list_source_v2.py (reused unchanged).
v3 adds, identically to O and AB, one measurement-environment patch (user
decision 22/10, K3v2-F2): the default per-IP read limit in
packages/runtime/src/http.ts goes from 3000 to 6000 per minute. The pinned stack
gives every PCN user the same client IP and routes all non-Clinic reads through
Core, so ~2,900 Core reads/min sat at 97% of the limit and produced random 429s
in any configuration. Writes and per-actor limits are unchanged. The repository
is not modified; both patches and the original hashes are in the manifest.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import stat
import sys
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cqrs_source as q6  # noqa: E402
import list_source_v2 as v2  # noqa: E402

REPO = q6.REPO
STUDY = 'cqrs-list-matched-kaggle-v3'
OUTPUT = REPO / 'test-results/phase2/cqrs/list-v3/cqrs-list-source-v11.zip'
READ_LIMIT_OLD = "limit(read?'API_READ_IP_LIMIT':'API_WRITE_IP_LIMIT',read?3000:1000)"
READ_LIMIT_NEW = "limit(read?'API_READ_IP_LIMIT':'API_WRITE_IP_LIMIT',read?6000:1000)"


def raise_read_limit(files, group):
    """Patch the same expression once in O and AB; fail closed otherwise."""
    files = dict(files)
    original = files[v2.RUNTIME_HTTP]
    text = original.decode('utf-8')
    q6.require(text.count(READ_LIMIT_OLD) == 1, 'V3_READ_LIMIT_NOT_FOUND_ONCE_' + group)
    patched = text.replace(READ_LIMIT_OLD, READ_LIMIT_NEW).encode('utf-8')
    files[v2.RUNTIME_HTTP] = patched
    return files, {'group': group, 'path': v2.RUNTIME_HTTP, 'sourceSha256': q6.digest(original), 'bundleSha256': q6.digest(patched),
                   'from': READ_LIMIT_OLD, 'to': READ_LIMIT_NEW}


def make_bundle(root=REPO, output=OUTPUT):
    root, output = Path(root).resolve(strict=True), Path(output).absolute()
    q6.require(Path(q6.git(root, 'rev-parse', '--show-toplevel').decode().strip()).resolve() == root, 'ROOT')
    head = q6.git(root, 'rev-parse', 'HEAD').decode().strip()
    q6.require(not output.exists(), 'OUTPUT_EXISTS')
    policy = q6.source_bytes(root, 'phase2-plan/cqrs/acceptance.json')
    q6.require(q6.digest(policy) == q6.POLICY_SHA, 'POLICY_DRIFT')
    committed, worktree = q6.baseline_files(root), q6.worktree_files(root)
    without_eb, eb = v2.exclude_eb(worktree)
    original, o_patch = raise_read_limit(committed, 'O')
    current, ab_patch = raise_read_limit(without_eb, 'AB')
    q6.require(q6.lf(original['package-lock.json']) == q6.lf(current['package-lock.json']), 'LOCKFILE_DRIFT')
    q6.require('services/clinic/src/readWorker.ts' in current and 'services/clinic/src/readWorker.ts' not in original, 'CQRS_SOURCE')
    helpers = {name: q6.source_bytes(root, name) for name in q6.HARNESS}
    sources = {'O': q6.snapshot(original), 'AB': q6.snapshot(current), 'harness': q6.snapshot(helpers)}
    changes = [{'path': name, 'change': 'added' if name not in original else 'deleted' if name not in current else
                'line_endings_only' if q6.lf(original[name]) == q6.lf(current[name]) else 'modified'}
               for name in sorted(original.keys() | current.keys()) if original.get(name) != current.get(name)]
    plan = q6.make_plan(json.loads(policy), sources)
    payload = {f'{group}/{name}': data for group, files in [('O', original), ('AB', current), ('harness', helpers)]
               for name, data in files.items()}
    payload.update({'policy.json': policy, 'plan.json': q6.canonical(plan) + b'\n'})
    manifest = {'format': q6.FORMAT, 'baseline_git_sha': q6.BASELINE,
                # Pinned reader compatibility; the real HEAD is v3.actualGitHead.
                'worktree_head': q6.BASELINE,
                'sources': sources, 'changes_from_O': changes, 'files': q6.entries(payload),
                'scope': 'Build/runtime source only; no .git/env/keys/uploads/generated/dependencies/results. '
                         'O committed bytes (3e88d7e) plus the shared read-limit patch; AB current tracked and untracked source minus E-b plus the same patch; shared harness overlay.',
                'validation': 'SOURCE_INTEGRITY_ONLY', 'measurements': 'NOT_RUN',
                'v3': {'study': STUDY, 'packer': 'benchmarks/phase2/kaggle/list_source_v3.py', 'actualGitHead': head,
                       'worktreeHeadField': 'set to baseline for the pinned cqrs_source.read_bundle check',
                       'abExclusions': eb,
                       'sharedEnvironmentPatch': {'decision': 'user 2026-10-22 (K3v2-F2): raise the default per-IP read limit for O and AB alike',
                                                  'reason': 'pinned stack: one client IP, all non-Clinic reads via Core (~2,900/min vs 3000/min) -> random 429 in any configuration',
                                                  'patches': [o_patch, ab_patch]}}}
    manifest['lockfile_equivalence'] = 'Identical after CRLF-to-LF normalization; original bytes and separate hashes retained'
    manifest['sha256'] = q6.digest(q6.canonical(manifest))
    payload['manifest.json'] = q6.canonical(manifest) + b'\n'
    q6.require(worktree == q6.worktree_files(root), 'WORKTREE_CHANGED_DURING_PACK')
    q6.require(all(q6.source_bytes(root, name) == data for name, data in helpers.items()), 'HARNESS_CHANGED_DURING_PACK')
    q6.require(q6.source_bytes(root, 'phase2-plan/cqrs/acceptance.json') == policy and
               q6.git(root, 'rev-parse', 'HEAD').decode().strip() == head, 'PROVENANCE_CHANGED_DURING_PACK')
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, 'x', ZIP_DEFLATED) as archive:
        for name, data in sorted(payload.items()):
            info = ZipInfo(name, date_time=(2026, 10, 22, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            archive.writestr(info, data)
    result = q6.verify_bundle(output)
    return {'archive': str(output), **result, 'actualGitHead': head}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    print(json.dumps(make_bundle(REPO, parser.parse_args().output), indent=2))
