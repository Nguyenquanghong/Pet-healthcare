"""Freeze the cqrs-list-matched-kaggle-v1 policy from the locked benchmark plan.

Thresholds, workloads, block order, generator validity and session rules are
copied verbatim from evidence/benchmark-plan-20261021.json (checked by equality);
only study identity, sources, profile fields and pool ceilings (D5 review F2) are
added. Writes a new file and sidecar; refuses to overwrite.
"""
import hashlib
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PLAN = REPO / 'phase2-plan/cqrs/clinic-activity/evidence/benchmark-plan-20261021.json'
PLAN_SHA = (REPO / 'phase2-plan/cqrs/clinic-activity/evidence/benchmark-plan-20261021.sha256')
TARGET = REPO / 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v1.policy.json'
STUDY = 'cqrs-list-matched-kaggle-v1'
# Per-process Prisma pool ceilings read from the pinned O/AB sources: every
# service process uses runtime databaseUrl() with DB_POOL_LIMIT=4 (set by
# stack.mjs); the AB read worker uses CLINIC_READ_PROJECTOR_POOL_LIMIT=1 and the
# B freshness audit (CLINIC_READ_MODE=projection only) connection_limit=1.
POOLS = {
    'O': {'core-api': 4, 'core-outbox': 4, 'billing-worker': 4, 'clinic-api': 4, 'clinic-worker': 4,
          'notification-api': 4, 'notification-worker': 4},
    'A': {'core-api': 4, 'core-outbox': 4, 'billing-worker': 4, 'clinic-api': 4, 'clinic-worker': 4,
          'notification-api': 4, 'notification-worker': 4, 'clinic-read-worker': 1},
    'B': {'core-api': 4, 'core-outbox': 4, 'billing-worker': 4, 'clinic-api': 4, 'clinic-audit': 1, 'clinic-worker': 4,
          'notification-api': 4, 'notification-worker': 4, 'clinic-read-worker': 1},
    'harness': {'stack-supervisor-per-database': 4},
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def policy():
    raw = PLAN.read_bytes()
    if PLAN_SHA.read_text(encoding='utf-8').split()[0] != digest(raw):
        raise ValueError('BENCHMARK_PLAN_HASH_MISMATCH')
    plan = json.loads(raw)
    listing = plan['listStudy']
    if listing['newStudyId'] != STUDY or plan['resourceClass'] != 'kaggle_shared_envelope':
        raise ValueError('BENCHMARK_PLAN_STUDY_MISMATCH')
    return {
        'version': STUDY + '-policy-1',
        'status': 'FROZEN_BEFORE_MEASUREMENT',
        'study': STUDY,
        'derivedFrom': {'path': PLAN.relative_to(REPO).as_posix(), 'sha256': digest(raw)},
        'resourceClass': plan['resourceClass'],
        'isolationClaimed': False,
        'sources': {'O': plan['sources']['O'], 'AB_list': plan['sources']['AB_list']},
        'configurations': listing['configurations'],
        'blocksForEachWorkload': listing['blocksForEachWorkload'],
        'queryHeavy': listing['queryHeavy'],
        'pcn': listing['pcn'],
        'acceptance': listing['acceptance'],
        'generatorValidity': plan['generatorValidity'],
        'sessions': plan['sessions'],
        'scope': listing['scope'],
        'excludes': listing['excludes'],
        'profile': {
            'keyFields': plan['sessions']['profileKey'],
            'buildDigest': 'path-normalized (tools/phase2/cqrs/activity/bench/profile.mjs); raw digest reported, not keyed',
            'poolCeilingsPerProcess': POOLS,
            'poolCheck': 'observed pg_stat_activity peak per database role <= sum of ceilings of the processes sharing that role',
        },
        'accounting': {
            'collector': 'tools/phase2/cqrs/activity/bench/collector.mjs via collector-cli.mjs, 1s, CLOCK_MONOTONIC windows',
            'applicationRoles': ['api', 'worker', 'relay', 'postgres', 'broker', 'redis', 'gateway'],
            'separateRoles': ['generator', 'controller'],
            'missingCoverage': 'TOTAL_COST_INCONCLUSIVE',
            'measuredWindowObservation': 'no stack observe/inspect actions inside measured windows; only the pool sampler (one pg_stat_activity catalog query/s over the private socket) runs, identically for O/A/B',
        },
        'readPath': {
            'queryHeavy': 'Q6 correct_path unchanged: O absent, A authoritative, B projection with matching generation (admin-unbilled authoritative); anything else is a contract error',
            'pcn': 'GET appointments: O absent, A authoritative, B projection with matching generation OR authoritative with X-Service-Degraded: clinic-read (V1 bounded fallback, counted and reported as listFallbackRate, no threshold); anything else is a path error',
        },
        'latencyForGrading': {'openLoop': 'scheduled -> completion (total_ms)', 'closedLoop': 'request start -> completion'},
        'percentile': 'nearest_rank',
        'freshnessRecovery': 'Reference only (listStudy.acceptance.freshnessAndRecoveryReference); NOT_RUN in this study unless matching evidence is supplied',
        'performanceMeasurementsAllowed': 'only after a readiness smoke in the same session records the profileKey and passes',
    }


def build(target=TARGET):
    target = Path(target)
    if target.exists():
        raise ValueError('LIST_POLICY_ALREADY_EXISTS')
    target.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(policy(), ensure_ascii=False, indent=2) + '\n').encode()
    target.write_bytes(data)
    target.with_suffix('').with_suffix('.sha256').write_bytes((digest(data) + '  ' + target.name + '\n').encode())
    return {'policy': target.relative_to(REPO).as_posix(), 'sha256': digest(data)}


if __name__ == '__main__':
    print(json.dumps(build()))
