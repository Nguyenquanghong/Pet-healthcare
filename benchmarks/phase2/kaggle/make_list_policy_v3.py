"""Freeze the cqrs-list-matched-kaggle-v3 policy from the frozen v2 policy.

v2 K3 (pcn) stopped on two causes found in its diagnostics: the list freshness
estimator (fixed in source, F4) and a per-IP read limit the pinned stack could
not configure (shared patch in bundle v11, F5). Thresholds, primary, blocks,
workloads, sessions, read-path contract and diagnostics are copied from v2 (and
so from v1) and checked by equality. Writes a new file and sidecar; refuses to
overwrite. Reads files locally only.
"""
import copy
import hashlib
import json
from pathlib import Path
import zipfile

REPO = Path(__file__).resolve().parents[3]
V2 = REPO / 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v2.policy.json'
V2_SHA = 'e5a2279d25fe44c5867cf6ab614c975134069c18860e7af7e1983ba5b85fd646'
TARGET = REPO / 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v3.policy.json'
STUDY = 'cqrs-list-matched-kaggle-v3'
BUNDLE = 'test-results/phase2/cqrs/list-v3/cqrs-list-source-v11.zip'
BUNDLE_SHA = '8c87465e9034aa1627038d2a656719a4da45d9c9877718bba03d45846df47fc9'
UNCHANGED = ('resourceClass', 'isolationClaimed', 'blocksForEachWorkload', 'queryHeavy', 'pcn', 'acceptance', 'generatorValidity',
             'sessions', 'excludes', 'profile', 'readPath', 'latencyForGrading', 'percentile', 'freshnessRecovery',
             'performanceMeasurementsAllowed', 'accounting', 'diagnostics')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def policy():
    raw = V2.read_bytes()
    if digest(raw) != V2_SHA:
        raise ValueError('LIST_V2_POLICY_HASH_MISMATCH')
    v2 = json.loads(raw)
    bundle = (REPO / BUNDLE).read_bytes()
    if digest(bundle) != BUNDLE_SHA:
        raise ValueError('LIST_V3_BUNDLE_HASH_MISMATCH')
    with zipfile.ZipFile(REPO / BUNDLE) as archive:
        manifest_bytes = archive.read('manifest.json')
    manifest = json.loads(manifest_bytes)
    v3 = copy.deepcopy(v2)
    v3.update({
        'version': STUDY + '-policy-1',
        'status': 'FROZEN_BEFORE_MEASUREMENT',
        'study': STUDY,
        'derivedFrom': {'path': V2.relative_to(REPO).as_posix(), 'sha256': V2_SHA, 'v2DerivedFrom': v2['derivedFrom'],
                        'v2Result': 'phase2-plan/cqrs/list-study/k3v2-fd95963d/review.json (K3v2 FAIL_CORRECTNESS at pcn-b0)'},
        'sources': {'O': dict(v2['sources']['O'], sharedEnvironmentPatch=manifest['v3']['sharedEnvironmentPatch']['patches'][0]),
                    'AB_list': {
                        'sourceBundle': BUNDLE, 'sourceBundleSha256': BUNDLE_SHA, 'sourceManifestSha256': digest(manifest_bytes),
                        'declaredManifestDigest': manifest['sha256'], 'abSourceTreeSha256': manifest['sources']['AB']['sha256'],
                        'oSourceTreeSha256': manifest['sources']['O']['sha256'],
                        'actualGitHead': manifest['v3']['actualGitHead'], 'projectionVersion': 1, 'sameBuildOnlyReaderChanges': True,
                        'newHarnessOverlayMustBeManifested': True, 'abExclusions': manifest['v3']['abExclusions'],
                        'sharedEnvironmentPatch': manifest['v3']['sharedEnvironmentPatch']}},
        'configurations': {'O': 'Pinned pre-CQRS source with its original schema and required components; shared per-IP read limit patch (6000/min)',
                           'A': 'Pinned AB_list v3 (V1 projection plus post-v1 and post-v2 fixes), authoritative reader; producer/projector enabled, shadow disabled; shared read limit patch',
                           'B': 'Identical AB_list v3 build and maintenance; projected reader, unbilled authoritative control'},
        'changesFromV2': [
            'AB source: bundle v11 = v10 plus F4 (list freshness uses the per-aggregate lag estimator, K3v2-F1)',
            'O and AB: identical default per-IP read limit 3000 -> 6000/min in packages/runtime/src/http.ts (K3v2-F2, measurement environment, user decision)',
            'Thresholds, primary, blocks, workloads, sessions, read-path contract and diagnostics sampler unchanged',
        ],
        'scope': 'Demonstrates the pinned AB_list v3 revision only (V1 projection with the post-v1/v2 fixes) under the shared read-limit patch; no V2 projection or future integrated-product recommendation',
    })
    for key in UNCHANGED:
        if v3[key] != v2[key]:
            raise ValueError('LIST_V3_FIELD_CHANGED:' + key)
    return v3


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
