"""Pack the O/AB/harness source bundle v13 for cqrs-final-matched-kaggle-v1.

v13 replaces v12 before any measurement: v12 was packed before the Clinic->Core
Circuit Breaker and the Notification session-revocation check (AQ-05), both on
measured request paths, so it was not the final product.

Same format, reader, E-b exclusion (list_source_v2) and shared measurement patch
(list_source_v3: per-IP read limit 3000 -> 6000/min for O and AB alike) as v11.
AB is the final product: the working tree after the CQRS decision (projection
maintenance off by default, ADR-CQRS-06) and AQ-09. The harness overlay adds the
F configuration (cqrs_runtime.mjs, stack.mjs, native_stack.py, cqrs_probe.py);
O/A/B behaviour is unchanged. The repository is not modified.
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
import list_source_v3 as v3  # noqa: E402

REPO = q6.REPO
STUDY = 'cqrs-final-matched-kaggle-v1'
OUTPUT = REPO / 'test-results/phase2/cqrs/final-v1/cqrs-final-source-v13.zip'


def make_bundle(root=REPO, output=OUTPUT):
    root, output = Path(root).resolve(strict=True), Path(output).absolute()
    q6.require(Path(q6.git(root, 'rev-parse', '--show-toplevel').decode().strip()).resolve() == root, 'ROOT')
    head = q6.git(root, 'rev-parse', 'HEAD').decode().strip()
    q6.require(not output.exists(), 'OUTPUT_EXISTS')
    policy = q6.source_bytes(root, 'phase2-plan/cqrs/acceptance.json')
    q6.require(q6.digest(policy) == q6.POLICY_SHA, 'POLICY_DRIFT')
    committed, worktree = q6.baseline_files(root), q6.worktree_files(root)
    without_eb, eb = v2.exclude_eb(worktree)
    original, o_patch = v3.raise_read_limit(committed, 'O')
    current, ab_patch = v3.raise_read_limit(without_eb, 'AB')
    q6.require(q6.lf(original['package-lock.json']) == q6.lf(current['package-lock.json']), 'LOCKFILE_DRIFT')
    q6.require('services/clinic/src/readProjection.ts' in current and 'services/clinic/src/readWorker.ts' not in original, 'FINAL_SOURCE')
    helpers = {name: q6.source_bytes(root, name) for name in q6.HARNESS}
    q6.require(b"'F'" in helpers['benchmarks/phase2/kaggle/cqrs_runtime.mjs'], 'HARNESS_WITHOUT_F')
    sources = {'O': q6.snapshot(original), 'AB': q6.snapshot(current), 'harness': q6.snapshot(helpers)}
    changes = [{'path': name, 'change': 'added' if name not in original else 'deleted' if name not in current else
                'line_endings_only' if q6.lf(original[name]) == q6.lf(current[name]) else 'modified'}
               for name in sorted(original.keys() | current.keys()) if original.get(name) != current.get(name)]
    plan = q6.make_plan(json.loads(policy), sources)
    payload = {f'{group}/{name}': data for group, files in [('O', original), ('AB', current), ('harness', helpers)]
               for name, data in files.items()}
    payload.update({'policy.json': policy, 'plan.json': q6.canonical(plan) + b'\n'})
    manifest = {'format': q6.FORMAT, 'baseline_git_sha': q6.BASELINE,
                # Pinned reader compatibility; the real HEAD is final.actualGitHead.
                'worktree_head': q6.BASELINE,
                'sources': sources, 'changes_from_O': changes, 'files': q6.entries(payload),
                'scope': 'Build/runtime source only; no .git/env/keys/uploads/generated/dependencies/results. '
                         'O committed bytes (3e88d7e) plus the shared read-limit patch; AB (final product) current tracked and untracked '
                         'source minus E-b plus the same patch; shared harness overlay with the F configuration.',
                'validation': 'SOURCE_INTEGRITY_ONLY', 'measurements': 'NOT_RUN',
                'final': {'study': STUDY, 'packer': 'benchmarks/phase2/kaggle/final_source.py', 'actualGitHead': head,
                          'worktreeHeadField': 'set to baseline for the pinned cqrs_source.read_bundle check',
                          'abExclusions': eb,
                          'sharedEnvironmentPatch': {'decision': 'user 2026-10-22 (K3v2-F2), kept from v3: same default per-IP read limit for O and AB',
                                                     'patches': [o_patch, ab_patch]},
                          'configurationF': 'AB source, CLINIC_READ_PROJECTION=off (product default), authoritative reader, no projector, no read diagnostics'}}
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
            info = ZipInfo(name, date_time=(2026, 10, 23, 0, 0, 0))
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
