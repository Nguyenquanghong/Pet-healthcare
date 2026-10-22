"""Freeze the cqrs-list-matched-kaggle-v2 policy from the frozen v1 policy.

v1 ended FAIL_CORRECTNESS (phase2-plan/cqrs/list-study/result-k2-k3-20261022.md).
v2 measures the fixed AB source (bundle v10) with the same workloads, block order,
generator validity, sessions, read-path contract and acceptance thresholds: those
fields are copied from v1 and checked by equality. Only study identity, AB source,
configuration wording, the diagnostics sampler and scope change. Writes a new file
and sidecar; refuses to overwrite. Reads files locally only.
"""
import copy
import hashlib
import json
from pathlib import Path
import zipfile

REPO = Path(__file__).resolve().parents[3]
V1 = REPO / 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v1.policy.json'
V1_SHA = '1ee0ff4474c9517ca732a7172ed17760ea084af7b17398421631afc56f4b72fd'
TARGET = REPO / 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v2.policy.json'
STUDY = 'cqrs-list-matched-kaggle-v2'
BUNDLE = 'test-results/phase2/cqrs/list-v2/cqrs-list-source-v10.zip'
BUNDLE_SHA = '08956163934b6b64016c7a86eca8285d9357c349e5bb544a40c5be5dedea3843'
UNCHANGED = ('resourceClass', 'isolationClaimed', 'blocksForEachWorkload', 'queryHeavy', 'pcn', 'acceptance', 'generatorValidity',
             'sessions', 'excludes', 'profile', 'readPath', 'latencyForGrading', 'percentile', 'freshnessRecovery',
             'performanceMeasurementsAllowed')
DIAGNOSTICS = {
    'sampler': 'benchmarks/phase2/kaggle/list_study_v2.py MemberDiagnostics, one thread per member, identical for O/A/B',
    'intervalSeconds': 5,
    'queries': ['outbox pending count and oldest age per service DB (core, clinic)', 'pg_stat_activity non-idle wait-event summary',
                'pg_stat_bgwriter checkpoint counters'],
    'files': ['postgres.log lines: checkpoint, automatic vacuum/analyze, ERROR/STATEMENT (SQL text only, parameters are placeholders)',
              'Clinic API CLINIC_READ_DIAGNOSTIC lines (already sanitized by readDiagnostics.ts)'],
    'cost': 'catalog/count queries over the private admin socket every 5 s inside measured windows; counted under the postgres role; reported, not subtracted',
    'grading': 'diagnostic only; never used for grading or replacement decisions',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def policy():
    raw = V1.read_bytes()
    if digest(raw) != V1_SHA:
        raise ValueError('LIST_V1_POLICY_HASH_MISMATCH')
    v1 = json.loads(raw)
    bundle = (REPO / BUNDLE).read_bytes()
    if digest(bundle) != BUNDLE_SHA:
        raise ValueError('LIST_V2_BUNDLE_HASH_MISMATCH')
    with zipfile.ZipFile(REPO / BUNDLE) as archive:
        manifest_bytes = archive.read('manifest.json')
    manifest = json.loads(manifest_bytes)
    v2 = copy.deepcopy(v1)
    v2.update({
        'version': STUDY + '-policy-1',
        'status': 'FROZEN_BEFORE_MEASUREMENT',
        'study': STUDY,
        'derivedFrom': {'path': V1.relative_to(REPO).as_posix(), 'sha256': V1_SHA, 'v1DerivedFrom': v1['derivedFrom'],
                        'v1Result': 'phase2-plan/cqrs/list-study/result-k2-k3-20261022.md (FINAL, FAIL_CORRECTNESS)'},
        'sources': {'O': v1['sources']['O'], 'AB_list': {
            'sourceBundle': BUNDLE, 'sourceBundleSha256': BUNDLE_SHA, 'sourceManifestSha256': digest(manifest_bytes),
            'declaredManifestDigest': manifest['sha256'], 'abSourceTreeSha256': manifest['sources']['AB']['sha256'],
            'actualGitHead': manifest['v2']['actualGitHead'], 'projectionVersion': 1, 'sameBuildOnlyReaderChanges': True,
            'newHarnessOverlayMustBeManifested': True, 'abExclusions': manifest['v2']['abExclusions']}},
        'configurations': {'O': v1['configurations']['O'],
                           'A': 'Pinned AB_list v2 (V1 projection plus post-v1 fixes), authoritative reader; producer/projector enabled, shadow disabled',
                           'B': 'Identical AB_list v2 build and maintenance; projected reader, unbilled authoritative control'},
        'changesFromV1': [
            'AB source: bundle v10 from the working tree at 21cbcff + uncommitted changes, including F1 batched persistent Clinic relay and F3 projected statement_timeout = remaining budget capped at 1000 ms; E-b rescue limiter excluded (user decision)',
            'Diagnostics sampler added identically for O/A/B (see diagnostics); thresholds, primary, blocks, workloads, sessions and read-path contract unchanged',
        ],
        'diagnostics': DIAGNOSTICS,
        'scope': 'Demonstrates the pinned AB_list v2 revision only (V1 projection with the post-v1 fixes); no V2 projection or future integrated-product recommendation',
    })
    v2['accounting'] = dict(v1['accounting'], measuredWindowObservation=v1['accounting']['measuredWindowObservation']
                            + '; v2 adds the diagnostics sampler (one set of catalog/count queries every 5 s over the same socket), identically for O/A/B')
    for key in UNCHANGED:
        if v2[key] != v1[key]:
            raise ValueError('LIST_V2_FIELD_CHANGED:' + key)
    return v2


def build(target=TARGET):
    target = Path(target)
    if target.exists():
        raise ValueError('LIST_POLICY_ALREADY_EXISTS')
    data = (json.dumps(policy(), ensure_ascii=False, indent=2) + '\n').encode()
    target.write_bytes(data)
    target.with_suffix('').with_suffix('.sha256').write_bytes((digest(data) + '  ' + target.name + '\n').encode())
    return {'policy': target.relative_to(REPO).as_posix(), 'sha256': digest(data)}


if __name__ == '__main__':
    print(json.dumps(build()))
