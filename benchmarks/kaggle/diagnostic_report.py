"""Validate and package diagnostic evidence, including stopped/partial suites."""

import csv
import json
from pathlib import Path
import re
import uuid
import zipfile

from diagnostics import DIAGNOSTIC_PROTOCOL, observed_workload

ALLOWED = {"manifest.json", "locust_final.json", "endpoint_final.json", "warmup_endpoint_final.json",
           "fixture-summary.json", "load_stats.csv", "load_failures.csv", "load_stats_history.csv",
           "load_exceptions.csv", "resources.json", "setup.log", "api.log", "warmup.log", "load.log", "postgres.log"}


def read_json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (ValueError, OSError):
        return {}


def export(evidence):
    evidence = Path(evidence)
    summary = read_json(evidence / "notebook-summary.json")
    if not summary.get("plan") or summary.get("benchmark_protocol") != DIAGNOSTIC_PROTOCOL:
        raise ValueError("Missing diagnostic plan/protocol; cannot label this evidence")
    rows, endpoint_rows, verified = [], [], []
    for case in summary["plan"]:
        name = f'{summary["label"]}_{case["name"]}'
        folder = evidence / name
        if folder.parent.resolve() != evidence.resolve():
            raise ValueError("Invalid diagnostic run path")
        manifest = read_json(folder / "manifest.json")
        final = read_json(folder / "locust_final.json")
        endpoints_file = read_json(folder / "endpoint_final.json")
        endpoints = endpoints_file.get("endpoints", [])
        if not isinstance(endpoints, list) or not all(isinstance(entry, dict) for entry in endpoints):
            endpoints = []
        valid = (manifest.get("commit") == summary["commit"] and manifest.get("dirty_worktree") is False
                 and manifest.get("benchmark_protocol") == DIAGNOSTIC_PROTOCOL
                 and manifest.get("profile") == case["profile"] and manifest.get("users") == case["users"]
                 and manifest.get("history_episodes") == case["history_rows"]
                 and manifest.get("fixture_owners_and_pets") == case["fixture_users"]
                 and manifest.get("duration") == f'{case["duration_seconds"]}s'
                 and manifest.get("warmup") == f'{case["warmup_seconds"]}s'
                 and manifest.get("spawn_rate_per_second") == case["spawn_rate"]
                 and (case["profile"] not in ("OwnerProbeUser", "AdminInterference") or
                      (manifest.get("owner_users") == case["owner_users"] and manifest.get("admin_users") == case["admin_users"]))
                 and final.get("phase") == endpoints_file.get("phase") == "measured"
                 and final.get("stats_source") == "locust_quitting" and final.get("requests", 0) > 0
                 and manifest.get("results") == {k: v for k, v in final.items() if k != "phase"}
                 and bool(endpoints) and observed_workload(case["profile"], endpoints)
                 and sum(e.get("requests", 0) for e in endpoints) == final.get("requests")
                 and sum(e.get("failures", 0) for e in endpoints) == final.get("failures"))
        within = valid and manifest.get("status") == "completed" and manifest.get("locust_exit_code") == 0 and manifest.get("threshold_exceeded") is False
        rows.append({"run": name, "verified_final": valid, "within_limits": within,
                     "status": manifest.get("status", "NOT_RUN" if not folder.exists() else "NO_MANIFEST"),
                     "requests": final.get("requests"), "failures": final.get("failures"),
                     "rps": final.get("achieved_rps"), "p95_ms": final.get("p95_ms"),
                     "limit_violations": manifest.get("endpoint_limit_violations", [])})
        if valid:
            verified.append((case, manifest, endpoints))
            for endpoint in endpoints:
                endpoint_rows.append({"run": name, "profile": case["profile"], "users": case["users"],
                    "history_episodes": case["history_rows"], **endpoint})
    # Ratios only use verified final counters from a matching control/busy pair.
    comparisons = []
    for repeat in (1, 2):
        pair = {}
        for case, manifest, endpoints in verified:
            if case["name"].endswith(f"_r{repeat}") and case["profile"] in ("OwnerProbeUser", "AdminInterference"):
                probe = next((e for e in endpoints if e["name"] == "OWNER probe GET /api/pets"), None)
                if probe:
                    pair[case["profile"]] = (case, manifest, probe)
        if len(pair) == 2:
            a, b = pair["OwnerProbeUser"], pair["AdminInterference"]
            same = all(a[0][k] == b[0][k] for k in ("history_rows", "fixture_users", "owner_users"))
            same = same and all(a[1].get(k) is not None and a[1].get(k) == b[1].get(k) for k in ("cpu_model", "cpu_count", "cpu_affinity", "memory_total_bytes", "node_version", "postgres_version", "locust_version"))
            if same:
                comparisons.append({"repeat": repeat, "owner_users": a[0]["owner_users"], "added_admin_users": b[0]["admin_users"],
                    "control_p95_ms": a[2]["p95_ms"], "with_admin_p95_ms": b[2]["p95_ms"],
                    "p95_ratio": b[2]["p95_ms"] / a[2]["p95_ms"] if a[2]["p95_ms"] else None,
                    "control_rps": a[2]["achieved_rps"], "with_admin_rps": b[2]["achieved_rps"],
                    "control_error_rate": a[2]["error_rate"], "with_admin_error_rate": b[2]["error_rate"]})
    complete = len(rows) == summary.get("expected_runs") == summary.get("attempted_runs") and not summary.get("stop_reason") and all(row["within_limits"] for row in rows)
    limit_reached = any(m.get("threshold_exceeded") is True for _, m, _ in verified)
    result = "COMPLETED_WITHIN_LIMITS" if complete else "LIMIT_REACHED" if limit_reached else "RUN_ERROR_OR_PARTIAL"
    summary.update({"result": result, "verified_runs": sum(row["verified_final"] for row in rows),
                    "within_limits_runs": sum(row["within_limits"] for row in rows), "runs": rows,
                    "interference_comparisons": comparisons})
    (evidence / "notebook-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    csv_path = evidence / "endpoint-summary.csv"
    columns = ["run", "profile", "users", "history_episodes", "method", "name", "stats_source", "requests", "failures", "error_rate", "achieved_rps", "p50_ms", "p95_ms", "p99_ms", "mean_response_bytes"]
    with csv_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        writer.writerows(endpoint_rows)
    archive = evidence.with_suffix(".zip")
    if archive.exists():
        archive = evidence.with_name(f"{evidence.name}-export-{uuid.uuid4().hex[:8]}.zip")
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as output:
        candidates = [evidence / "notebook-summary.json", csv_path, *evidence.glob("*-runner.log")]
        candidates.extend(file for folder in evidence.iterdir() if folder.is_dir()
                          for file in folder.iterdir() if file.name in ALLOWED and file.is_file())
        for file in candidates:
            member = f"{evidence.name}/{file.relative_to(evidence).as_posix()}"
            if file.suffix == ".log":
                safe = file.read_text(encoding="utf-8", errors="replace")
                safe = re.sub(r"postgres(?:ql)?://[^\s'\"]+", "[REDACTED_DATABASE_URL]", safe, flags=re.IGNORECASE)
                safe = re.sub(r"Bearer\s+[A-Za-z0-9._~-]+", "Bearer [REDACTED]", safe, flags=re.IGNORECASE)
                output.writestr(member, safe)
            else:
                output.write(file, member)
    return summary, archive


if __name__ == "__main__":
    import sys
    summary, archive = export(Path(sys.argv[1]))
    print(json.dumps({"result": summary["result"], "verified_runs": summary["verified_runs"],
        "expected_runs": summary["expected_runs"], "stop_reason": summary.get("stop_reason"),
        "interference_comparisons": summary["interference_comparisons"], "archive": str(archive)}, ensure_ascii=False, indent=2))
