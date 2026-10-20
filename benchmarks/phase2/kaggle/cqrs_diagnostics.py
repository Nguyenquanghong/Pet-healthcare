"""Export only bounded, schema-validated CQRS events from owned private logs.

No raw log, exception message, arbitrary field, URL, token or SQL is exported.
Collection happens after teardown, including failed warmups. Missing/truncated
telemetry is explicit and never upgrades a workload gate.
"""
import hashlib
import json
import math
from pathlib import Path

PREFIX = b'CLINIC_READ_DIAGNOSTIC '
OPERATIONS = {'unknown','freshness','owner-list','owner-calendar','admin-list','admin-calendar','admin-page','admin-search','admin-filter','admin-unbilled'}
STAGES = {'start','projection-admission','projection-acquire','projection-setup','projection-control','projection-token','projection-query','projection-plan','projection-search','projection-counts','projection-aggregate-boundary','projection-aggregate-first','projection-aggregate-next','projection-items','projection-directory-version','projection-directory','projection-calendar','projection-commit','fallback-acquire','fallback-setup','fallback-query','fallback-commit','freshness-broker','freshness-acquire','freshness-control','freshness-diff','freshness-commit'}
EVENTS = {'enabled','admission_wait','admission_ready','cache_hit','cache_miss','cache_coalesced','cache_wait','projection_ok','projection_failure','fallback_ok','fallback_error','fallback_busy','sample_ok','sample_error','limit'}
REASONS = {'none','query_error','control_unavailable','freshness_missing','freshness_expired','freshness_generation','freshness_lag','freshness_unhealthy','freshness_clock','version_pending','budget_exhausted','broker_unavailable','projection_not_ready','projection_version_invalid','sample_error','forced_source'}
PRISMA_CODES = {None,'P1001','P1002','P1008','P1017','P2010','P2021','P2022','P2024','P2028','P2034'}
SQL_STATES = {None,'57014','55P03','53100','53200','53300','40001','40P01','42501','42P01','42703','08006'}
FIELDS = {'version','sequence','id','operation','stage','event','reason','prismaCode','sqlState','atUnixMs','elapsedMs','stageMs'}


def validated(row):
    if not isinstance(row, dict) or set(row) != FIELDS:
        return False
    for field, allowed in [('operation',OPERATIONS),('stage',STAGES),('event',EVENTS),('reason',REASONS),('prismaCode',PRISMA_CODES),('sqlState',SQL_STATES)]:
        if row[field] is not None and not isinstance(row[field], str): return False
        if row[field] not in allowed: return False
    for field in ('version','sequence','id','atUnixMs'):
        if type(row[field]) is not int or not 1 <= row[field] <= 9007199254740991: return False
    if row['version'] != 1 or row['sequence'] > 513: return False
    for field in ('elapsedMs','stageMs'):
        if type(row[field]) not in (float,int) or not 0 <= row[field] <= 86400000 or not math.isfinite(row[field]): return False
    return True


def collect(private, replicas, output):
    """Never propagate a collection failure into, or conceal, the load result."""
    result = {'status':'COLLECTED','records':0,'rejected':0,'limited':False,'scan_truncated':False,'missing_logs':0}
    rows = []
    try:
        if type(replicas) is not int or not 1 <= replicas <= 3: raise ValueError('REPLICAS')
        private = Path(private).resolve()
        for replica in range(replicas):
            path = private / f'clinic-{replica}.log'
            if path.is_symlink() or not path.is_file():
                result['missing_logs'] += 1
                continue
            seen, scanned, last_sequence = 0, 0, 0
            with path.open('rb') as handle:
                while scanned < 16 * 1024 * 1024:
                    line = handle.readline(8193)
                    if not line: break
                    scanned += len(line)
                    if len(line) > 8192:
                        if line.startswith(PREFIX): result['rejected'] += 1
                        while line and not line.endswith(b'\n') and scanned < 16 * 1024 * 1024:
                            line = handle.readline(8193); scanned += len(line)
                        continue
                    if not line.startswith(PREFIX): continue
                    try:
                        row = json.loads(line[len(PREFIX):])
                        if not validated(row) or row['sequence'] <= last_sequence:
                            raise ValueError('SCHEMA')
                    except (ValueError,TypeError,UnicodeError,RecursionError):
                        result['rejected'] += 1
                        continue
                    if seen >= 513:
                        result['scan_truncated'] = True
                        break
                    seen += 1; last_sequence = row['sequence']
                    result['limited'] |= row['event'] == 'limit'
                    rows.append({'component':f'clinic-{replica}', **row})
                if scanned >= 16 * 1024 * 1024: result['scan_truncated'] = True
        path = Path(output) / 'read-diagnostics.jsonl'
        data = ''.join(json.dumps(row, separators=(',',':'))+'\n' for row in rows).encode()
        path.write_bytes(data)
        result.update(records=len(rows),sha256=hashlib.sha256(data).hexdigest())
        if not rows: result['status'] = 'NO_EVENTS'
        if result['limited']: result['status'] = 'LIMIT_REACHED'
        if result['rejected'] or result['scan_truncated'] or result['missing_logs']: result['status'] = 'INCOMPLETE'
    except (OSError,ValueError,TypeError) as error:
        result.update(status='COLLECTION_ERROR',error_type=type(error).__name__)
    return result
