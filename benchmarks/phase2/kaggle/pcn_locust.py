"""Reuse the phase-1 PCN load verbatim; adapt only the phase-2 wire contract.

Locust imports this as the sole locustfile. Raw HTTP statuses supplement, never
replace, the original phase-1 timing, error counts and acceptance denominator.
"""
import csv
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'kaggle'))
import pcn_locustfile as legacy
from locust import events
from pcn_adapter import contract_error, request_headers

DETAILS = None
WRITER = None
WRITES = None
USER_ERRORS = 0


@events.test_start.add_listener
def open_details(environment, **kwargs):
    global DETAILS, WRITER, WRITES
    DETAILS = open(os.environ['PCN_HTTP'], 'w', newline='', encoding='utf-8')
    WRITER = csv.DictWriter(DETAILS, fieldnames=['started_seconds', 'operation', 'status', 'latency_ms', 'failed'])
    WRITER.writeheader()
    WRITES = open(os.environ['PCN_WRITES'], 'w', encoding='utf-8')


def checked(self, method, path, name, expected=200, **kwargs):
    with self.client.request(method, path, name=name, timeout=10, catch_response=True,
                             headers=request_headers(method, name), **kwargs) as response:
        if response.status_code != expected:
            response.failure(f'Expected HTTP {expected}, received {response.status_code}')
            return
        try:
            body = response.json()
            error = contract_error(method, name, body, self.fixture['petId'])
            if error:
                response.failure(error)
            elif name == 'POST appointment':
                # Private reconciliation ledger includes ramp/warmup writes too.
                identifier = body['appointment'].get('id')
                if not isinstance(identifier, str):
                    response.failure('Created appointment has no ID')
                else:
                    WRITES.write(json.dumps({'id': identifier}) + '\n')
        except (ValueError, TypeError, AttributeError):
            response.failure('Invalid JSON response')


legacy.PcnUser.checked = checked
PcnUser = legacy.PcnUser


@events.user_error.add_listener
def capture_user_error(user_instance, exception, tb, **kwargs):
    global USER_ERRORS
    USER_ERRORS += 1


@events.request.add_listener
def capture_status(name, response_time, response, exception, context, **kwargs):
    if not context or not context.get('pcn_measured'):
        return
    WRITER.writerow({'started_seconds': context['pcn_start'] - legacy.STATE['start'],
                     'operation': name, 'status': getattr(response, 'status_code', 0),
                     'latency_ms': response_time, 'failed': exception is not None})


@events.quitting.add_listener
def close_details(environment, **kwargs):
    for handle in (DETAILS, WRITES):
        if handle:
            handle.close()
    Path(os.environ['PCN_GENERATOR']).write_text(json.dumps({'user_errors': USER_ERRORS}))
