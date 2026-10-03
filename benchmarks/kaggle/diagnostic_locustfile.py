"""Bounded admin dashboard/page reads and an owner probe share the real API and DB."""

import json
import os
from pathlib import Path

from locust import HttpUser, between, events, task
from locustfile import BasePetUser, MixedUser  # Reuse the unchanged B1 write mix and final aggregate hook.
from diagnostics import endpoint_stats

FIXTURE = json.loads(Path(os.environ["BENCH_FIXTURE"]).read_text(encoding="utf-8"))


@events.quitting.add_listener
def save_endpoints(environment, **_kwargs):
    path = os.environ.get("BENCH_ENDPOINT_STATS")
    if path:
        Path(path).write_text(json.dumps({"phase": os.environ.get("BENCH_PHASE"),
            "endpoints": endpoint_stats(environment.stats.entries.values())}, indent=2), encoding="utf-8")


class OwnerProbeUser(BasePetUser):
    fixed_count = int(os.environ.get("BENCH_OWNER_USERS", "50"))

    @task
    def probe(self):
        with self.client.get("/api/pets", name="OWNER probe GET /api/pets", timeout=10, catch_response=True) as response:
            if response.status_code == 200:
                try:
                    pets = response.json().get("items", [])
                    if not isinstance(pets, list) or not any(pet.get("id") == self.fixture["petId"] for pet in pets):
                        response.failure("Owner probe missing its synthetic pet")
                except (ValueError, TypeError, AttributeError):
                    response.failure("Owner probe invalid JSON schema")


class AdminBase(HttpUser):
    abstract = True
    wait_time = between(2, 4)

    def on_start(self):
        self.client.headers.update({"Authorization": f"Bearer {FIXTURE['admin']['token']}"})

    def read(self, path):
        params = {"view": "dashboard"} if path == "/api/bootstrap" else {"page": 1, "pageSize": 20}
        with self.client.get(path, params=params, name=f"ADMIN GET {path}", timeout=10, catch_response=True) as response:
            if response.status_code == 200:
                try:
                    body = response.json()
                    valid = isinstance(body, dict) and isinstance(body.get("owners"), list) if path == "/api/bootstrap" else isinstance(body, dict) and isinstance(body.get("items"), list)
                    if not valid:
                        response.failure("Admin read invalid JSON schema")
                except ValueError:
                    response.failure("Admin read invalid JSON")


class AdminReadUser(AdminBase):
    @task(4)
    def bootstrap(self): self.read("/api/bootstrap")

    @task(2)
    def appointments(self): self.read("/api/appointments")

    @task(2)
    def hotel(self): self.read("/api/hotel-bookings")

    @task(1)
    def invoices(self): self.read("/api/invoices")

    @task(1)
    def notifications(self): self.read("/api/notifications")


class AdminBootstrapUser(AdminBase):
    fixed_count = int(os.environ.get("BENCH_ADMIN_USERS", "5"))

    @task
    def bootstrap(self): self.read("/api/bootstrap")
