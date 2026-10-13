"""Measure a full 30-minute window AFTER ramp and warmup, with raw request evidence."""
import itertools
import json
import os
import random
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import gevent
from locust import HttpUser, between, events, task
from pcn_contract import PROTOCOL, percentile

FIXTURE = json.loads(Path(os.environ["BENCH_FIXTURE"]).read_text(encoding="utf-8"))
USERS = FIXTURE["users"]
TARGET = int(os.environ.get("PCN_USERS", "100"))
DURATION = int(os.environ.get("PCN_DURATION", "1800"))
WARMUP = int(os.environ.get("PCN_WARMUP", "30"))
INDEX = itertools.count()
STATE = {"start": None, "end": None, "completed": False, "started": 0, "counts": [],
         "population": [], "latencies": [], "endpoints": defaultdict(list), "worker": None, "raw": None}
random.seed(20261006)


@events.test_start.add_listener
def initialize(environment, **kwargs):
    STATE["raw"] = open(os.environ["PCN_RAW"], "w", encoding="utf-8")


def measure(environment):
    gevent.sleep(WARMUP)
    if environment.runner.user_count != TARGET:
        environment.runner.quit()
        return
    STATE["start"] = time.monotonic()
    STATE["end"] = STATE["start"] + DURATION
    while time.monotonic() < STATE["end"]:
        STATE["population"].append(environment.runner.user_count)
        gevent.sleep(min(1, max(0, STATE["end"] - time.monotonic())))
    STATE["completed"] = True
    environment.runner.quit()


@events.spawning_complete.add_listener
def spawned(user_count, **kwargs):
    if user_count == TARGET and STATE["worker"] is None:
        STATE["worker"] = gevent.spawn(measure, ENVIRONMENT)


@events.init.add_listener
def initialized(environment, **kwargs):
    global ENVIRONMENT
    ENVIRONMENT = environment


@events.request.add_listener
def request_done(request_type, name, response_time, response_length, exception, context, **kwargs):
    if not context or not context.get("pcn_measured"):
        return
    elapsed = context["pcn_start"] - STATE["start"]
    failed = exception is not None
    latency = float(response_time)
    STATE["latencies"].append(latency)
    STATE["counts"].append(failed)
    STATE["endpoints"][name].append((latency, failed))
    STATE["raw"].write(json.dumps({"started_seconds": elapsed, "method": request_type, "name": name,
                                    "response_time_ms": latency, "failed": failed,
                                    "response_bytes": response_length}) + "\n")


@events.quitting.add_listener
def final(environment, **kwargs):
    endpoints = []
    for name, items in sorted(STATE["endpoints"].items()):
        endpoints.append({"name": name, "requests": len(items), "failures": sum(f for _, f in items),
                          "p95_ms": percentile([latency for latency, _ in items]),
                          "within_2s_success_ratio": sum(not f and latency <= 2000 for latency, f in items) / len(items)})
    population = STATE["population"]
    count = len(STATE["latencies"])
    data = {"protocol": PROTOCOL, "completed": STATE["completed"],
            "measured_seconds": DURATION if STATE["completed"] else
            (max(0, time.monotonic() - STATE["start"]) if STATE["start"] is not None else 0),
            "requests": count, "started_requests": STATE["started"], "failures": sum(STATE["counts"]),
            "error_rate": sum(STATE["counts"]) / count if count else None,
            "p95_ms": percentile(STATE["latencies"]), "endpoints": endpoints,
            "observed_user_min": min(population) if population else None,
            "observed_user_max": max(population) if population else None,
            "population_samples": population, "warmup_after_ramp_seconds": WARMUP,
            "measurement": "Requests started inside the full window; responses include drain; warmup and ramp excluded."}
    Path(os.environ["PCN_FINAL"]).write_text(json.dumps(data, indent=2), encoding="utf-8")
    if STATE["raw"]:
        STATE["raw"].close()


class PcnUser(HttpUser):
    wait_time = between(0.5, 1.5)

    def on_start(self):
        self.fixture = USERS[next(INDEX)]
        self.client.headers.update({"Authorization": f"Bearer {self.fixture['token']}"})
        self.sequence = 0

    def context(self):
        now = time.monotonic()
        measured = STATE["start"] is not None and STATE["start"] <= now < STATE["end"]
        if measured:
            STATE["started"] += 1
            STATE["population"].append(ENVIRONMENT.runner.user_count)
        return {"pcn_measured": measured, "pcn_start": now}

    def checked(self, method, path, name, expected=200, **kwargs):
        with self.client.request(method, path, name=name, timeout=10, catch_response=True, **kwargs) as response:
            if response.status_code != expected:
                response.failure(f"Expected HTTP {expected}, received {response.status_code}")
                return
            try:
                body = response.json()
                if method == "GET" and not isinstance(body, (dict, list)):
                    response.failure("Invalid JSON collection")
                elif name == "POST appointment" and body.get("appointment", {}).get("petId") != self.fixture["petId"]:
                    response.failure("Created appointment does not belong to the selected pet")
                elif name == "GET pets" and not any(x.get("id") == self.fixture["petId"] for x in body):
                    response.failure("Own pet missing from response")
            except (ValueError, TypeError, AttributeError):
                response.failure("Invalid JSON response")

    @task(4)
    def pets(self): self.checked("GET", "/api/pets", "GET pets")

    @task(2)
    def appointments(self): self.checked("GET", "/api/appointments", "GET appointments")

    @task(2)
    def medical(self): self.checked("GET", f"/api/medical-records?petId={self.fixture['petId']}", "GET medical by pet")

    @task(1)
    def hotel(self): self.checked("GET", "/api/hotel-bookings", "GET hotel")

    @task(1)
    def invoices(self): self.checked("GET", "/api/invoices", "GET invoices")

    @task(1)
    def notifications(self): self.checked("GET", "/api/notifications", "GET notifications")

    @task(2)
    def appointment(self):
        number = self.sequence
        self.sequence += 1
        day = date(2099, 1, 1) + timedelta(days=number // 1440)
        self.checked("POST", "/api/appointments", "POST appointment", expected=201,
                     json={"petId": self.fixture["petId"], "type": "general_checkup", "serviceName": "PCN synthetic checkup",
                           "date": day.isoformat(), "time": f"{number % 1440 // 60:02d}:{number % 60:02d}"})

    @task(1)
    def rescue(self):
        self.checked("POST", f"/api/public/pets/{self.fixture['qrToken']}/rescue-reports", "POST rescue report", expected=201,
                     json={"finderPhone": "0000000000", "location": "Synthetic PCN test location"})
