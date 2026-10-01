"""Closed-loop workloads for the existing REST API; fixture tokens stay outside result logs."""

import itertools
import json
import os
import random
from pathlib import Path

from locust import HttpUser, between, task, events
from metrics import appointment_slot, final_stats

with open(os.environ["BENCH_FIXTURE"], encoding="utf-8") as fixture_file:
    USERS = json.load(fixture_file)["users"]

random.seed(int(os.environ.get("BENCH_SEED_NUMBER", "20260923")))
USER_INDEX = itertools.count()


@events.quitting.add_listener
def save_final_stats(environment, **_kwargs):
    path = os.environ.get("BENCH_FINAL_STATS")
    if path:
        data = {"phase": os.environ.get("BENCH_PHASE"), **final_stats(environment.stats.total)}
        Path(path).write_text(json.dumps(data, indent=2), encoding="utf-8")


class BasePetUser(HttpUser):
    abstract = True
    wait_time = between(0.5, 1.5)

    def on_start(self):
        self.fixture = USERS[next(USER_INDEX) % len(USERS)]
        self.client.headers.update({"Authorization": f"Bearer {self.fixture['token']}"})
        self.appointment_number = 0

    def get_bootstrap(self):
        self.client.get("/api/bootstrap", name="GET /api/bootstrap", timeout=10)

    def get_pets(self):
        self.client.get("/api/pets", name="GET /api/pets", timeout=10)

    def get_appointments(self):
        self.client.get("/api/appointments", name="GET /api/appointments", timeout=10)

    def get_notifications(self):
        self.client.get("/api/notifications", name="GET /api/notifications", timeout=10)


class ReadHeavyUser(BasePetUser):
    @task(40)
    def bootstrap(self): self.get_bootstrap()

    @task(25)
    def pets(self): self.get_pets()

    @task(20)
    def appointments(self): self.get_appointments()

    @task(15)
    def notifications(self): self.get_notifications()


class MixedUser(BasePetUser):
    @task(30)
    def bootstrap(self): self.get_bootstrap()

    @task(20)
    def pets(self): self.get_pets()

    @task(15)
    def appointments(self): self.get_appointments()

    @task(5)
    def notifications(self): self.get_notifications()

    @task(20)
    def rescue_report(self):
        self.client.post(
            f"/api/public/pets/{self.fixture['qrToken']}/rescue-reports",
            name="POST /api/public/pets/{token}/rescue-reports",
            timeout=10,
            json={"finderPhone": "0000000000", "location": "Synthetic test location"},
        )

    @task(10)
    def create_appointment(self):
        day, slot = appointment_slot(self.appointment_number, os.environ.get("BENCH_PHASE", "measured"))
        self.appointment_number += 1
        self.client.post(
            "/api/appointments",
            name="POST /api/appointments",
            timeout=10,
            json={"petId": self.fixture["petId"], "type": "general_checkup", "serviceName": "Synthetic checkup", "date": day, "time": slot},
        )
