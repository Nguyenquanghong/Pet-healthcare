"""Freeze the cqrs-final-matched-kaggle-v1 policy (final product F against pre-CQRS O).

Derived from the frozen v3 list-study policy. Workloads, generator, sessions,
validity, accounting, diagnostics and profile key are copied and checked by
equality. What changes, all decided before any measurement: two configurations
(O, F), matched block orders O,F / F,O / O,F, F's read path (authoritative), F's
pool ceilings (O's processes: no read worker, no audit lane) and the gates, which
are F/O non-regression bounds taken from the v3 acceptance values. Writes a new
file and sidecar; refuses to overwrite. Reads files locally only.
"""
import copy
import hashlib
import json
from pathlib import Path
import zipfile

REPO = Path(__file__).resolve().parents[3]
V3 = REPO / 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v3.policy.json'
V3_SHA = '0c3ea454fed4f17173788e8f5cf5be00b4d968735099a04fbf42e21f3d3905eb'
TARGET = REPO / 'phase2-plan/cqrs/final/cqrs-final-matched-kaggle-v1.policy.json'
STUDY = 'cqrs-final-matched-kaggle-v1'
BUNDLE = 'test-results/phase2/cqrs/final-v1/cqrs-final-source-v12.zip'
BUNDLE_SHA = 'b09c57525749c6da529bde85e15ad33fbdd5c42699bee2183dfa8536d5fc63f2'
UNCHANGED = ('resourceClass', 'isolationClaimed', 'queryHeavy', 'pcn', 'generatorValidity', 'sessions', 'excludes',
             'latencyForGrading', 'percentile', 'performanceMeasurementsAllowed', 'accounting', 'diagnostics')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def policy():
    raw = V3.read_bytes()
    if digest(raw) != V3_SHA:
        raise ValueError('LIST_V3_POLICY_HASH_MISMATCH')
    v3 = json.loads(raw)
    bundle = (REPO / BUNDLE).read_bytes()
    if digest(bundle) != BUNDLE_SHA:
        raise ValueError('FINAL_BUNDLE_HASH_MISMATCH')
    with zipfile.ZipFile(REPO / BUNDLE) as archive:
        manifest_bytes = archive.read('manifest.json')
    manifest = json.loads(manifest_bytes)
    acc, pools = v3['acceptance'], v3['profile']['poolCeilingsPerProcess']
    final = copy.deepcopy(v3)
    for key in ('changesFromV1', 'changesFromV2'):
        final.pop(key, None)
    final.update({
        'version': STUDY + '-policy-1',
        'status': 'FROZEN_BEFORE_MEASUREMENT',
        'study': STUDY,
        'derivedFrom': {'path': V3.relative_to(REPO).as_posix(), 'sha256': V3_SHA,
                        'decision': 'phase2-plan/cqrs/FINAL-CQRS-20261023.md and ADR-CQRS-06: lists read the source; projection maintenance off by default'},
        'sources': {'O': dict(v3['sources']['O'], sharedEnvironmentPatch=manifest['final']['sharedEnvironmentPatch']['patches'][0]),
                    'F_final': {
                        'sourceBundle': BUNDLE, 'sourceBundleSha256': BUNDLE_SHA, 'sourceManifestSha256': digest(manifest_bytes),
                        'declaredManifestDigest': manifest['sha256'], 'abSourceTreeSha256': manifest['sources']['AB']['sha256'],
                        'oSourceTreeSha256': manifest['sources']['O']['sha256'], 'harnessTreeSha256': manifest['sources']['harness']['sha256'],
                        'actualGitHead': manifest['final']['actualGitHead'], 'abExclusions': manifest['final']['abExclusions'],
                        'sharedEnvironmentPatch': manifest['final']['sharedEnvironmentPatch'],
                        'configurationF': manifest['final']['configurationF']}},
        'configurations': {'O': 'Pinned pre-CQRS source with its original schema and required components; shared per-IP read limit patch (6000/min)',
                           'F': 'Final product: AB source at the CQRS decision with CLINIC_READ_PROJECTION=off (default), authoritative reader, '
                                'no read-revision events, no projector, no read diagnostics; shared read limit patch'},
        'blocksForEachWorkload': [['O', 'F'], ['F', 'O'], ['O', 'F']],
        'acceptance': {
            'matchedBlocksRequired': 3,
            'finalNonRegressionAgainstO': {
                'primaryListP95RatioMax': acc['pcnAppointmentListP95RatioMax'],
                'calendarP95RatioMax': acc['queryHeavyOwnerAndAdminCalendarP95RatioToOMax'],
                'pcnAppointmentListP95RatioMax': acc['pcnAppointmentListP95RatioMax'],
                'writeP95RatioMax': acc['wholeFeatureNonRegressionAgainstO']['writeP95RatioMax'],
                'applicationCpuPerSuccessRatioMax': acc['wholeFeatureNonRegressionAgainstO']['applicationCpuPerSuccessRatioMax'],
                'successfulThroughputRatioMin': acc['wholeFeatureNonRegressionAgainstO']['successfulThroughputRatioMin']},
            'thresholdSource': 'every bound copied from the v3 acceptance; the query-heavy primary list uses the same 1.1 bound as the PCN list and the calendars',
            'grading': 'Every valid matched block separately (every pair within the bound); decision NO_REGRESSION only when both workloads are graded and every gate passes',
            'healthyUnexpectedErrorsAndDrops': acc['healthyUnexpectedErrorsAndDrops'],
            'noOwnerLeakOrContractMismatch': acc['noOwnerLeakOrContractMismatch']},
        'profile': dict(v3['profile'], poolCeilingsPerProcess={'O': pools['O'], 'F': dict(pools['O']), 'harness': pools['harness']}),
        'readPath': {'queryHeavy': 'Q6 correct_path: O absent, F authoritative (no projection headers); anything else is a contract error',
                     'pcn': 'GET appointments: O absent, F authoritative; F has no projection and no fallback, anything else is a path error'},
        'freshnessRecovery': 'Not applicable: F maintains no read model',
        'changesFromV3': [
            'Configurations O and F (final product) instead of O/A/B; blocks O,F / F,O / O,F',
            'Gates: F/O non-regression with v3 bounds; no read-path improvement gates (the projection was rejected by K2v2)',
            'Source bundle v12: AB = working tree at the CQRS decision and AQ-09 (minus E-b), same shared read-limit patch as v11',
            'Harness overlay: F configuration added to cqrs_runtime.mjs, stack.mjs, native_stack.py, cqrs_probe.py; O/A/B unchanged',
            'Member runner final_trial.py (list_trial.py unchanged, configurations O and F)'],
        'scope': 'Final product F against the pre-CQRS source O on the Kaggle shared envelope; includes every change since 3e88d7e, not only the CQRS switch',
    })
    for key in UNCHANGED:
        if final[key] != v3[key]:
            raise ValueError('FINAL_POLICY_FIELD_CHANGED:' + key)
    return final


def build(target=TARGET):
    target = Path(target)
    if target.exists():
        raise ValueError('FINAL_POLICY_ALREADY_EXISTS')
    target.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(policy(), ensure_ascii=False, indent=2) + '\n').encode()
    target.write_bytes(data)
    target.with_suffix('').with_suffix('.sha256').write_bytes((digest(data) + '  ' + target.name + '\n').encode())
    return {'policy': target.relative_to(REPO).as_posix(), 'sha256': digest(data)}


if __name__ == '__main__':
    print(json.dumps(build()))
