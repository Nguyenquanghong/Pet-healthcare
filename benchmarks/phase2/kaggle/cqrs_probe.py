"""Observe the actual HTTP read path; never infer it from an env flag."""
import time
import re


def read_evidence(headers, expected_generation=None):
    values = {k.lower(): v for k, v in headers.items()}
    source = values.get('x-clinic-read-source')
    diagnostic_id = values.get('x-clinic-read-diagnostic-id', '')
    diagnostic = {'diagnostic_id':int(diagnostic_id)} if isinstance(diagnostic_id,str) and re.fullmatch(r'[1-9][0-9]{0,14}',diagnostic_id) else {}
    return {**diagnostic, 'read_source': source if source in ('authoritative', 'projection') else 'absent' if source is None else 'invalid',
            'generation_matches': bool(expected_generation) and values.get('x-clinic-projection-generation') == expected_generation,
            'degraded': values.get('x-service-degraded') == 'clinic-read'}


def correct_path(mode, evidence, *, unbilled=False):
    if mode not in ('O', 'A', 'B', 'F'):  # F: final product, authoritative reader
        raise ValueError('Unknown Q6 configuration')
    expected = 'absent' if mode == 'O' else 'projection' if mode == 'B' and not unbilled else 'authoritative'
    return evidence['read_source'] == expected and (expected != 'projection' or evidence['generation_matches'])


def preflight(client, mode, generation):
    # Setup-only readiness polling; all measured requests retain their first
    # result. No login, mutation or idempotency-key retries here.
    deadline = time.monotonic() + 15
    checks = []
    while time.monotonic() < deadline:
        checks = []
        for endpoint in ('/api/appointments', '/api/appointments/calendar?month=2028-02'):
            status, _, headers = client.request('GET', endpoint, token=client.actors[0]['token'])
            evidence = read_evidence(headers, generation)
            checks.append({'operation': 'calendar' if 'calendar' in endpoint else 'list', 'status': status, **evidence})
        if all(c['status'] == 200 and correct_path(mode, c) for c in checks):
            return checks
        time.sleep(.25)
    raise RuntimeError('Q6 read path not ready; stop before measurement')
