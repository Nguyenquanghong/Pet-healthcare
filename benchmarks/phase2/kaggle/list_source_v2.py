"""Pack the O/AB/harness source bundle for cqrs-list-matched-kaggle-v2.

Same archive format and reader as the Q6 bundle (cqrs_source.py, unchanged and
byte-pinned): O is read from Git object 3e88d7e, AB is the current working tree,
harness is the unchanged Q6 harness. Differences from cqrs_source.pack, all
recorded in the manifest:
- HEAD no longer equals the baseline. The pinned reader requires
  worktree_head == baseline, so that field keeps the baseline value and the real
  HEAD is stored in `v2.actualGitHead`.
- AB excludes the E-b rescue-report limiter (user decision 22/10): the pinned
  Kaggle stack cannot set its thresholds and the PCN trace would hit it, while O
  has no such limiter. Only that branch of packages/runtime/src/http.ts and its
  test file are removed; the repository is not modified.
No commit, checkout, build or DB access.
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

REPO = q6.REPO
STUDY = 'cqrs-list-matched-kaggle-v2'
OUTPUT = REPO / 'test-results/phase2/cqrs/list-v2/cqrs-list-source-v10.zip'
RUNTIME_HTTP = 'packages/runtime/src/http.ts'
EB_BRANCH = (
    "    // AQ-01: unauthenticated rescue reports notify an owner. The token bucket caps\n"
    "    // a flood against one pet across IPs; the token is HMACed with the other keys.\n"
    "    const rescue=req.method==='POST'?req.path.match(/^\\/public\\/pets\\/([^/]{1,200})\\/rescue-reports$/):null;\n"
    "    if(rescue){let token=rescue[1]!;try{token=decodeURIComponent(token);}catch{}\n"
    "      return{group:'public-rescue',read:false,buckets:[b(ip,limit('RESCUE_REPORT_IP_LIMIT',20)),b('rescue-token:'+token,limit('RESCUE_REPORT_TOKEN_LIMIT',5))]};}\n")
EB_TEST = 'packages/runtime/tests/rescue-limit.test.mjs'


def exclude_eb(current):
    """Return (AB files, exclusion record); fail closed if the branch is not found exactly once."""
    files = dict(current)
    original = files[RUNTIME_HTTP]
    q6.require(original.decode('utf-8').count(EB_BRANCH) == 1, 'V2_EB_BRANCH_NOT_FOUND_ONCE')
    patched = original.decode('utf-8').replace(EB_BRANCH, '').encode('utf-8')
    files[RUNTIME_HTTP] = patched
    removed = files.pop(EB_TEST, None)
    q6.require(removed is not None, 'V2_EB_TEST_NOT_FOUND')
    record = {'decision': 'user 2026-10-22: exclude E-b rescue limiter from the measured AB source',
              'reason': 'pinned stack strips env (RESCUE_REPORT_* cannot be set); PCN trace sends ~12.5k rescue reports/30 min from one IP over 100 tokens; O has no such limiter',
              'patchedFiles': [{'path': RUNTIME_HTTP, 'worktreeSha256': q6.digest(original), 'bundleSha256': q6.digest(patched),
                                'removedText': EB_BRANCH}],
              'removedFiles': [{'path': EB_TEST, 'worktreeSha256': q6.digest(removed)}]}
    return files, record


def make_bundle(root=REPO, output=OUTPUT):
    root, output = Path(root).resolve(strict=True), Path(output).absolute()
    q6.require(Path(q6.git(root, 'rev-parse', '--show-toplevel').decode().strip()).resolve() == root, 'ROOT')
    head = q6.git(root, 'rev-parse', 'HEAD').decode().strip()
    q6.require(not output.exists(), 'OUTPUT_EXISTS')
    policy = q6.source_bytes(root, 'phase2-plan/cqrs/acceptance.json')
    q6.require(q6.digest(policy) == q6.POLICY_SHA, 'POLICY_DRIFT')
    original, worktree = q6.baseline_files(root), q6.worktree_files(root)
    current, exclusion = exclude_eb(worktree)
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
                # Pinned reader compatibility; the real HEAD is v2.actualGitHead.
                'worktree_head': q6.BASELINE,
                'sources': sources, 'changes_from_O': changes, 'files': q6.entries(payload),
                'scope': 'Build/runtime source only; no .git/env/keys/uploads/generated/dependencies/results. '
                         'O committed bytes (3e88d7e); AB current tracked and untracked source minus the E-b exclusion; shared harness overlay.',
                'validation': 'SOURCE_INTEGRITY_ONLY', 'measurements': 'NOT_RUN',
                'v2': {'study': STUDY, 'packer': 'benchmarks/phase2/kaggle/list_source_v2.py', 'actualGitHead': head,
                       'worktreeHeadField': 'set to baseline for the pinned cqrs_source.read_bundle check; AB bytes come from the working tree at actualGitHead plus uncommitted changes',
                       'abExclusions': exclusion}}
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
    return {'archive': str(output), **result, 'actualGitHead': head, 'abExcluded': [RUNTIME_HTTP + ' (E-b branch)', EB_TEST]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    print(json.dumps(make_bundle(REPO, parser.parse_args().output), indent=2))
