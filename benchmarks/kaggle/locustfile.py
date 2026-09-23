"""Closed-loop workloads for the existing REST API; fixture tokens stay outside result logs."""

import itertools
import json
import os
import random

from locust import HttpUser, between, task

with open(os.environ["BENCH_FIXTURE"], encoding="utf-8") as fixture_file:
    USERS = json.load(fixture_file)["users"]

random.seed(int(os.environ.get("BENCH_SEED_NUMBER", "20260923")))
USER_INDEX = itertools.count()


class BasePetUser(HttpUser):
    abstract = True
    wait_time = between(0.5, 1.5)

    def on_start(self):
        self.fixture = USERS[next(USER_INDEX) % len(USERS)]
        self.client.headers.update({"Authorization": f"Bearer {self.fixture['token']}"})
        self.appointment_number = 0

    def get_bootstrap(self):
        self.client.get("/api/bootstrap", name="GET /api/bootstrap")

    def get_pets(self):
        self.client.get("/api/pets", name="GET /api/pets")

    def get_appointments(self):
        self.client.get("/api/appointments", name="GET /api/appointments")

    def get_notifications(self):
        self.client.get("/api/notifications", name="GET /api/notifications")


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
            json={"finderPhone": "0000000000", "location": "Synthetic test location"},
        )

    @task(10)
    def create_appointment(self):
        minute = self.appointment_number % 1440
        self.appointment_number += 1
        self.client.post(
            "/api/appointments",
            name="POST /api/appointments",
            json={"petId": self.fixture["petId"], "type": "general_checkup", "serviceName": "Synthetic checkup", "date": "2099-01-01", "time": f"{minute // 60:02d}:{minute % 60:02d}"},
        )
