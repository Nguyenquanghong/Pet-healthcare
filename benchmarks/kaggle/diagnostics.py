"""Exploratory scenarios; separate from the accepted phase1-kaggle-v3 matrix."""

import math

DIAGNOSTIC_PROTOCOL = "architecture-diagnostics-v2"
PROFILES = {
    "AdminReadUser": ["AdminReadUser"],
    "OwnerProbeUser": ["OwnerProbeUser"],
    "AdminInterference": ["OwnerProbeUser", "AdminBootstrapUser"],
    "MixedUser": ["MixedUser"],
}


def build_plan(suite):
    """Fixed population/data across a load sweep, fresh DB per run, AB/BA pairs."""
    def case(name, profile, users, rows, repeat, steady=300):
        ramp = math.ceil(users / 10)
        return {"name": f"{name}_r{repeat}", "profile": profile, "users": users,
                "history_rows": rows, "fixture_users": 500, "spawn_rate": 10,
                "warmup_seconds": max(45, ramp + 15), "duration_seconds": steady + ramp,
                "owner_users": 50 if profile in ("OwnerProbeUser", "AdminInterference") else 0,
                "admin_users": 5 if profile == "AdminInterference" else 0}

    if suite == "data":
        return [case(f"admin_history_{rows}", "AdminReadUser", 3, rows, repeat)
                for rows in (1000, 10000, 50000) for repeat in (1, 2)]
    if suite == "interference":
        # Same owner population and dataset; only five admin readers are added.
        return [case(name, profile, users, 10000, repeat)
                for repeat, order in ((1, (False, True)), (2, (True, False)))
                for busy in order
                for name, profile, users in [
                    ("owners_plus_admin", "AdminInterference", 55) if busy else
                    ("owners_only", "OwnerProbeUser", 50)]]
    if suite == "stress":
        return [case(f"mixed_{users}", "MixedUser", users, 10000, repeat)
                for users in (100, 200, 300, 500) for repeat in (1, 2)]
    if suite == "soak":
        return [case("mixed_soak_100", "MixedUser", 100, 10000, 1, steady=1800)]
    raise ValueError("suite must be data, interference, stress or soak")


def endpoint_stats(entries):
    """Final per-endpoint counters; do not substitute periodic CSV snapshots."""
    from metrics import final_stats
    return [{"method": entry.method, "name": entry.name, **final_stats(entry),
             "mean_response_bytes": entry.total_content_length / entry.num_requests}
            for entry in sorted(entries, key=lambda entry: (entry.method or "", entry.name))
            if entry.num_requests]


def exceeded_endpoints(entries, p95_limit_ms=2000, owner_probe_limit_ms=500):
    """Exploratory limits, not production SLAs. Retain each violating endpoint."""
    return [entry["name"] for entry in entries
            if entry["error_rate"] is None or entry["error_rate"] > 0.01
            or entry["p95_ms"] is None
            or entry["p95_ms"] > (owner_probe_limit_ms if entry["name"].startswith("OWNER probe") else p95_limit_ms)]


def observed_workload(profile, entries):
    """A mixed-role result is invalid if only its fast owner control ran."""
    names = {entry.get("name") for entry in entries if entry.get("requests", 0) > 0}
    if profile == "AdminReadUser":
        return "ADMIN GET /api/bootstrap" in names
    if profile == "OwnerProbeUser":
        return "OWNER probe GET /api/pets" in names
    if profile == "AdminInterference":
        return {"OWNER probe GET /api/pets", "ADMIN GET /api/bootstrap"} <= names
    if profile == "MixedUser":
        return {"GET", "POST"} <= {entry.get("method") for entry in entries if entry.get("requests", 0) > 0}
    return False
