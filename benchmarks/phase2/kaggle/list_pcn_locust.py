"""List-study overlay on the pinned PCN locustfile (pcn_locust.py, unchanged).

Locust loads only this file. Importing pcn_locust keeps the phase-1 tasks,
weights, wait time, contract checks and measured window exactly; this overlay
only records, for the measured window:
  * per-request raw with user index, CLOCK_MONOTONIC start, status, read path;
  * the wait chosen before each task (per-user task/wait/start/completion);
  * a 10 Hz gevent event-loop delay probe (generatorValidity.closedLoop);
  * absolute window bounds and population samples.
"""
import json
import os
import time

import gevent
from locust import events

import pcn_locust as base
from pcn_locust import PcnUser  # noqa: F401  (the user class Locust runs)

legacy = base.legacy
RAW = None
PROBE = None
GENERATION = os.environ.get('LIST_PCN_GENERATION') or None

_start, _context, _wait = legacy.PcnUser.on_start, legacy.PcnUser.context, legacy.PcnUser.wait_time


def on_start(self):
    _start(self)
    self.list_user = legacy.USERS.index(self.fixture)
    self.list_wait = None


def context(self):
    value = _context(self)
    value.update(list_user=getattr(self, 'list_user', None), list_wait=getattr(self, 'list_wait', None))
    return value


def wait_time(self):
    self.list_wait = _wait(self)
    return self.list_wait


legacy.PcnUser.on_start, legacy.PcnUser.context, legacy.PcnUser.wait_time = on_start, context, wait_time


def measured(now):
    start, end = legacy.STATE['start'], legacy.STATE['end']
    return start is not None and start <= now < end


def probe():
    while True:
        before = time.monotonic()
        gevent.sleep(0.1)
        after = time.monotonic()
        if measured(before):
            PROBE.write(json.dumps({'at': before, 'delayMs': max(0.0, (after - before - 0.1) * 1000)}) + '\n')


@events.test_start.add_listener
def opened(environment, **kwargs):
    global RAW, PROBE
    RAW = open(os.environ['LIST_PCN_RAW'], 'w', encoding='utf-8')
    PROBE = open(os.environ['LIST_PCN_PROBE'], 'w', encoding='utf-8')
    gevent.spawn(probe)


@events.request.add_listener
def recorded(request_type, name, response_time, response_length, response, exception, context, **kwargs):
    if not context or not context.get('pcn_measured'):
        return
    headers = getattr(response, 'headers', {}) or {}
    source = headers.get('X-Clinic-Read-Source')
    RAW.write(json.dumps({
        'user': context.get('list_user'), 'waitBeforeSeconds': context.get('list_wait'), 'name': name, 'method': request_type,
        'startMonotonic': context['pcn_start'], 'latencyMs': float(response_time), 'status': getattr(response, 'status_code', 0),
        'failed': exception is not None, 'bytes': response_length,
        'readSource': source if source in ('authoritative', 'projection') else 'absent' if source is None else 'invalid',
        'generationMatches': GENERATION is not None and headers.get('X-Clinic-Projection-Generation') == GENERATION,
        'degraded': headers.get('X-Service-Degraded') == 'clinic-read'}) + '\n')


@events.quitting.add_listener
def closed(environment, **kwargs):
    for handle in (RAW, PROBE):
        if handle:
            handle.close()
    state = legacy.STATE
    with open(os.environ['LIST_PCN_WINDOW'], 'w', encoding='utf-8') as handle:
        json.dump({'startMonotonicMs': state['start'] * 1000 if state['start'] is not None else None,
                   'endMonotonicMs': state['end'] * 1000 if state['end'] is not None else None,
                   'completed': state['completed'], 'targetUsers': legacy.TARGET,
                   'populationMin': min(state['population']) if state['population'] else None,
                   'populationMax': max(state['population']) if state['population'] else None}, handle)
