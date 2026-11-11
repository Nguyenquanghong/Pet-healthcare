"""M/H bridge workload: the PCN locustfile with bookings both versions accept.

Task weights, URLs, pacing, timeouts, measurement window and raw evidence are the
phase-1 PCN file's, through the phase-2 wire adapter (pcn_locust.py), which also
accepts the monolith's plain arrays. Two tasks change, identically for M and H:

- POST appointment. PCN books one pet at every minute of a day. Since P10 the
  current product accepts only 30-minute slots 08:00-17:00 with a per-slot
  capacity, so every booking here takes its own (day, slot) on that grid: no slot
  is ever full and no pet overlaps. The monolith accepts the same requests.
- POST rescue report. Each report carries a distinct finder phone, so the current
  product's 10-minute dedup (AQ-01) never merges one: both versions write a row
  and a notification for every report.
"""
import itertools
import json
import os
import time
from datetime import date, timedelta

import pcn_locust as adapter

legacy = adapter.legacy
SLOTS_PER_DAY = 19  # 08:00, 08:30, ..., 17:00
PHONES = itertools.count(1)


def booking(index):
    day = date(2099, 1, 1) + timedelta(days=index // SLOTS_PER_DAY)
    minutes = 8 * 60 + 30 * (index % SLOTS_PER_DAY)
    return day.isoformat(), f'{minutes // 60:02d}:{minutes % 60:02d}'


def appointment(self):
    number = self.sequence
    self.sequence += 1
    day, time = booking(number * len(legacy.USERS) + self.slot_offset)
    self.checked('POST', '/api/appointments', 'POST appointment', expected=201,
                 json={'petId': self.fixture['petId'], 'type': 'general_checkup', 'serviceName': 'PCN synthetic checkup',
                       'date': day, 'time': time})


def rescue(self):
    self.checked('POST', f"/api/public/pets/{self.fixture['qrToken']}/rescue-reports", 'POST rescue report', expected=201,
                 json={'finderPhone': f'0{next(PHONES):09d}', 'location': 'Synthetic PCN test location'})


legacy_start = legacy.PcnUser.on_start


def on_start(self):
    legacy_start(self)
    self.slot_offset = legacy.USERS.index(self.fixture)


# Locust drew the weighted task list from the class body; swap the two entries in
# place so weights stay 4/2/2/1/1/1/2/1.
SWAP = {legacy.PcnUser.appointment: appointment, legacy.PcnUser.rescue: rescue}
legacy.PcnUser.tasks = [SWAP.get(task, task) for task in legacy.PcnUser.tasks]
legacy.PcnUser.on_start = on_start
PcnUser = legacy.PcnUser


# The notification burst (K9) is fired relative to the moment the measurement window opens, which only this process knows: the phase-1 locustfile sets
# legacy.STATE['start'] (time.monotonic()) once the population is complete and the warmup is over. With PCN_WINDOW set, that moment is written there once, as JSON, atomically.
# Without it (every member that has no burst, and the monolith's) nothing below runs and locust is not imported by this module.
WINDOW = os.environ.get('PCN_WINDOW')


def publish_window(path, state, sleep, monotonic=time.monotonic, epoch=time.time):
    """Waits until state['start'] has a value, then writes {'start_monotonic', 'seen_monotonic', 'seen_epoch'} to `path` (through a temporary file, so a reader never sees half of it).
    time.monotonic is one clock for every process of the machine, so the controller compares its own readings with start_monotonic directly; seen_* are the offset between epoch and monotonic."""
    while state['start'] is None:
        sleep(0.05)
    record = {'start_monotonic': state['start'], 'seen_monotonic': monotonic(), 'seen_epoch': epoch()}
    temporary = f'{path}.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        json.dump(record, handle)
    os.replace(temporary, path)
    return record


if WINDOW:
    import gevent
    from locust import events

    @events.test_start.add_listener
    def watch_window(environment, **kwargs):
        gevent.spawn(publish_window, WINDOW, legacy.STATE, gevent.sleep)
