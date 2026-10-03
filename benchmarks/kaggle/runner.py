"""Run one isolated Kaggle CPU benchmark. Never point this at an existing database."""

import argparse
import csv
import json
import os
import platform
import pwd
import signal
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import psutil
from metrics import BENCHMARK_PROTOCOL, CpuSampler
from ports import require_free_port
from diagnostics import DIAGNOSTIC_PROTOCOL, PROFILES as DIAGNOSTIC_PROFILES, exceeded_endpoints, observed_workload


def command(args, *, cwd=None, env=None, stdout=None):
    return subprocess.run(args, cwd=cwd, env=env, stdout=stdout, stderr=subprocess.STDOUT if stdout else None, check=True, text=True)


def output(args, *, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def wait_health(port, process, timeout=60):
    import urllib.request

    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if process.poll() is not None:
            raise RuntimeError("API exited before health became ready")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as response:
                if json.load(response)["status"] == "ok":
                    return
        except Exception:
            time.sleep(1)
    raise RuntimeError("API health did not become ready")


def process_usage(pid, sampler):
    try:
        parent = psutil.Process(pid)
        members = [parent, *parent.children(recursive=True)]
        times = {}
        rss = 0
        for item in members:
            try:
                cpu = item.cpu_times()
                times[(item.pid, item.create_time())] = cpu.user + cpu.system
                rss += item.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return {"cpu_percent_per_core_total": sampler.sample(time.monotonic(), times), "rss_bytes": rss}
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return {"cpu_percent_per_core_total": None, "rss_bytes": None}


def run_locust(repo, environment, profile, users, spawn_rate, duration, log_path, csv_prefix=None):
    diagnostic = environment.get("BENCH_DIAGNOSTIC") == "1"
    workload = "diagnostic_locustfile.py" if diagnostic else "locustfile.py"
    classes = DIAGNOSTIC_PROFILES[profile] if diagnostic else [profile]
    args = [sys.executable, "-m", "locust", "-f", str(repo / "benchmarks/kaggle" / workload), *classes,
            "--headless", "--only-summary", "--host", "http://127.0.0.1:5001",
            "--users", str(users), "--spawn-rate", str(spawn_rate), "--run-time", duration, "--stop-timeout", "12"]
    if csv_prefix:
        args.extend(["--csv", str(csv_prefix), "--csv-full-history"])
    log = open(log_path, "w", encoding="utf-8")
    process = subprocess.Popen(args, cwd=repo, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    return process, log


def stop_process(process):
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except ProcessLookupError:
        process.wait()
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def aggregated_stats(csv_path):
    with open(csv_path, newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    row = next((item for item in rows if item.get("Name") == "Aggregated"), None)
    if not row:
        raise RuntimeError("Locust aggregate row missing from stats CSV")
    requests = int(row["Request Count"])
    failures = int(row["Failure Count"])
    return {
        "requests": requests,
        "failures": failures,
        "error_rate": failures / requests if requests else None,
        "achieved_rps": float(row["Requests/s"]),
        "p50_ms": float(row["50%"]),
        "p95_ms": float(row["95%"]),
        "p99_ms": float(row["99%"]),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--profile", choices=["ReadHeavyUser", *DIAGNOSTIC_PROFILES], required=True)
    parser.add_argument("--users", type=int, required=True)
    parser.add_argument("--spawn-rate", type=float, default=5)
    parser.add_argument("--warmup", default="45s")
    parser.add_argument("--duration", default="2m")
    parser.add_argument("--seed", default="phase1")
    parser.add_argument("--diagnostic", action="store_true")
    parser.add_argument("--history-rows", type=int, default=10000)
    parser.add_argument("--fixture-users", type=int, default=500)
    parser.add_argument("--owner-users", type=int, default=50)
    parser.add_argument("--admin-users", type=int, default=5)
    parser.add_argument("--p95-limit-ms", type=float, default=2000)
    parser.add_argument("--owner-probe-limit-ms", type=float, default=500)
    args = parser.parse_args()

    if args.diagnostic:
        if args.profile not in DIAGNOSTIC_PROFILES or not 1 <= args.history_rows <= 100000 or not 1 <= args.fixture_users <= 1000:
            parser.error("Invalid diagnostic profile, history rows or fixture population")
        if args.fixture_users < args.users or not 0 < args.p95_limit_ms < float("inf") or not 0 < args.owner_probe_limit_ms < float("inf"):
            parser.error("Diagnostic population must cover users and latency limits must be positive and finite")
        if args.profile in ("OwnerProbeUser", "AdminInterference") and (
            args.owner_users < 1 or args.admin_users < 0 or args.owner_users + args.admin_users != args.users
            or (args.profile == "OwnerProbeUser" and args.admin_users != 0)
            or (args.profile == "AdminInterference" and args.admin_users < 1)
        ):
            parser.error("Owner/admin fixed counts must match the requested diagnostic users")
    elif args.profile not in ("ReadHeavyUser", "MixedUser"):
        parser.error("Admin/probe profiles require --diagnostic")

    repo = args.repo.resolve(strict=True)
    result_dir = args.output.resolve()
    if not (repo / "backend/prisma/schema.prisma").is_file():
        raise RuntimeError("--repo must be the Pet Healthcare checkout")
    if not Path("/kaggle/working").is_dir():
        raise RuntimeError("This evidence runner must execute on a Kaggle CPU notebook")
    if not str(result_dir).startswith("/kaggle/working/"):
        raise RuntimeError("--output must be under /kaggle/working")
    if args.users < 1 or args.spawn_rate <= 0:
        raise RuntimeError("users and spawn-rate must be positive")
    for program in ("node", "npm", "pg_config", "psql", "createdb"):
        if not shutil.which(program):
            raise RuntimeError(f"Missing {program}; install it in this Kaggle session before the run")
    pg_bin = Path(os.environ["BENCH_PG_BIN"]) if os.environ.get("BENCH_PG_BIN") else Path(output(["pg_config", "--bindir"]))
    for program in ("initdb", "pg_ctl"):
        if not (pg_bin / program).is_file():
            raise RuntimeError(f"Missing PostgreSQL binary: {pg_bin / program}")
    require_free_port(55432)
    require_free_port(5001)
    result_dir.mkdir(parents=True, exist_ok=False)

    metadata = {
        "benchmark_protocol": DIAGNOSTIC_PROTOCOL if args.diagnostic else BENCHMARK_PROTOCOL,
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "commit": output(["git", "rev-parse", "HEAD"], cwd=repo),
        "dirty_worktree": bool(output(["git", "status", "--porcelain"], cwd=repo)),
        "platform": platform.platform(),
        "cpu_count": psutil.cpu_count(logical=True),
        "cpu_affinity": psutil.Process().cpu_affinity(),
        "cpu_model": next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines() if line.startswith("model name")), platform.processor()),
        "memory_total_bytes": psutil.virtual_memory().total,
        "node_version": output(["node", "--version"]),
        "npm_version": output(["npm", "--version"]),
        "postgres_version": output([str(pg_bin / "postgres"), "--version"]),
        "locust_version": output([sys.executable, "-m", "locust", "--version"]),
        "python_version": platform.python_version(),
        "profile": args.profile,
        "users": args.users,
        "spawn_rate_per_second": args.spawn_rate,
        "warmup": args.warmup,
        "duration": args.duration,
        "fixture_seed": args.seed,
        "fixture_owners_and_pets": max(100, args.users),
        "read_contract": {"collection": "items-pagination-related", "page": 1, "page_size": 20, "bootstrap_view": "dashboard", "api_contract": "3.0.0"},
        "wait_seconds_uniform": [0.5, 1.5],
        "task_weights": ({"GET bootstrap": 40, "GET pets": 25, "GET appointments": 20, "GET notifications": 15}
                         if args.profile == "ReadHeavyUser" else
                         {"GET bootstrap": 30, "GET pets": 20, "GET appointments": 15, "GET notifications": 5, "POST rescue report": 20, "POST appointment": 10}),
        "stop_conditions": {"error_rate_gt": 0.01, "p95_ms_gt": 2000},
        "request_timeout_seconds": 10,
        "stop_timeout_seconds": 12,
        "measurement_window": "separate measured process; includes ramp-up at the stated spawn rate",
        "offered_rps": None,
        "load_model": "closed-loop users with think time; independent offered RPS is not defined",
        "generator_shares_cpu": True,
        "resource_sampling": "CPU time deltas, first sample null; short-lived processes between polls may be missed; RSS sums can include shared pages",
        "status": "running",
    }
    if args.diagnostic:
        metadata.update({"fixture_owners_and_pets": args.fixture_users, "fixture_seed": "diagnostic",
            "history_episodes": args.history_rows, "fixture_rows_per_episode": 8,
            "owner_users": args.users if args.profile == "MixedUser" else args.owner_users if args.profile in ("OwnerProbeUser", "AdminInterference") else 0,
            "admin_users": args.users if args.profile == "AdminReadUser" else args.admin_users if args.profile == "AdminInterference" else 0,
            "load_classes": DIAGNOSTIC_PROFILES[args.profile],
            "wait_seconds_uniform": {"owner": [0.5, 1.5], "admin": [2, 4]},
            "task_weights": ({"GET bootstrap": 4, "GET appointments": 2, "GET hotel-bookings": 2, "GET invoices": 1, "GET notifications": 1}
                             if args.profile == "AdminReadUser" else
                             {"OWNER probe GET pets": 1, "ADMIN GET bootstrap": 1} if args.profile == "AdminInterference" else
                             {"OWNER probe GET pets": 1} if args.profile == "OwnerProbeUser" else metadata["task_weights"]),
            "stop_conditions": {"error_rate_gt": 0.01, "p95_ms_gt": args.p95_limit_ms,
                                "owner_probe_p95_ms_gt": args.owner_probe_limit_ms,
                                "scope": "aggregate and each final endpoint; checked after each run; exploratory, not a business SLA"}})
    (result_dir / "manifest.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    api = None
    warmup = load = None
    api_log = warmup_log = load_log = None
    pg_started = False
    with tempfile.TemporaryDirectory(prefix="nipopeto-kaggle-") as temporary:
        temporary_path = Path(temporary)
        data_dir = temporary_path / "pgdata"
        data_dir.mkdir()
        pg_log = temporary_path / "postgres.log"
        fixture_path = temporary_path / "fixture.json"
        run_as_postgres = os.geteuid() == 0
        if run_as_postgres:
            if not shutil.which("runuser"):
                raise RuntimeError("runuser is required when Kaggle executes as root")
            pg_user = pwd.getpwnam("postgres")
            os.chown(temporary_path, pg_user.pw_uid, pg_user.pw_gid)
            os.chown(data_dir, pg_user.pw_uid, pg_user.pw_gid)
            prefix = ["runuser", "-u", "postgres", "--"]
        else:
            prefix = []
        try:
            with open(result_dir / "setup.log", "w", encoding="utf-8") as setup_log:
                command(prefix + [str(pg_bin / "initdb"), "-D", str(data_dir), "-U", "postgres", "-A", "trust", "--no-instructions"], stdout=setup_log)
                command(prefix + [str(pg_bin / "pg_ctl"), "-D", str(data_dir), "-l", str(pg_log), "-o", f"-c listen_addresses=127.0.0.1 -p 55432 -k {temporary_path}", "start"], stdout=setup_log)
                pg_started = True
                command(["createdb", "-h", "127.0.0.1", "-p", "55432", "-U", "postgres", "nipopeto"], stdout=setup_log)

            environment = os.environ.copy()
            # A previous diagnostic invocation must not contaminate a B1 run.
            for key in ("BENCH_DIAGNOSTIC", "BENCH_ENDPOINT_STATS", "BENCH_HISTORY_ROWS", "BENCH_FIXTURE_SUMMARY", "BENCH_OWNER_USERS", "BENCH_ADMIN_USERS"):
                environment.pop(key, None)
            environment["DATABASE_URL"] = "postgresql://postgres@127.0.0.1:55432/nipopeto?schema=public"
            environment["JWT_SECRET"] = secrets.token_urlsafe(40)
            environment["PORT"] = "5001"
            environment["BENCH_FIXTURE"] = str(fixture_path)
            environment["BENCH_PASSWORD"] = secrets.token_urlsafe(24)
            environment["BENCH_USERS"] = str(max(100, args.users))
            environment["BENCH_SEED"] = args.seed
            environment["BENCH_SEED_NUMBER"] = "20260923"
            if args.diagnostic:
                environment.update({"BENCH_DIAGNOSTIC": "1", "BENCH_USERS": str(args.fixture_users),
                    "BENCH_HISTORY_ROWS": str(args.history_rows), "BENCH_OWNER_USERS": str(args.owner_users),
                    "BENCH_ADMIN_USERS": str(args.admin_users), "BENCH_FIXTURE_SUMMARY": str(result_dir / "fixture-summary.json")})
            with open(result_dir / "setup.log", "a", encoding="utf-8") as setup_log:
                command(["npm", "ci"], cwd=repo, env=environment, stdout=setup_log)
                command(["npm", "run", "build", "-w", "backend"], cwd=repo, env=environment, stdout=setup_log)
                command(["npm", "run", "db:deploy", "-w", "backend"], cwd=repo, env=environment, stdout=setup_log)
            api_log = open(result_dir / "api.log", "w", encoding="utf-8")
            api = subprocess.Popen(["npm", "run", "start", "-w", "backend"], cwd=repo, env=environment, stdout=api_log, stderr=subprocess.STDOUT, start_new_session=True)
            wait_health(5001, api)
            with open(result_dir / "setup.log", "a", encoding="utf-8") as setup_log:
                fixture_script = "prepare_diagnostic_fixture.mjs" if args.diagnostic else "prepare_fixture.mjs"
                command(["node", str(repo / "benchmarks/kaggle" / fixture_script)], cwd=repo, env=environment, stdout=setup_log)

            environment["BENCH_PHASE"] = "warmup"
            environment.pop("BENCH_FINAL_STATS", None)
            if args.diagnostic:
                environment["BENCH_ENDPOINT_STATS"] = str(result_dir / "warmup_endpoint_final.json")
            warmup, warmup_log = run_locust(repo, environment, args.profile, args.users, args.spawn_rate, args.warmup, result_dir / "warmup.log")
            warmup_code = warmup.wait()
            warmup_log.close()
            if warmup_code != 0:
                raise RuntimeError(f"Locust warmup exited {warmup_code}; inspect warmup.log")

            environment["BENCH_PHASE"] = "measured"
            environment["BENCH_FINAL_STATS"] = str(result_dir / "locust_final.json")
            if args.diagnostic:
                environment["BENCH_ENDPOINT_STATS"] = str(result_dir / "endpoint_final.json")
            load, load_log = run_locust(repo, environment, args.profile, args.users, args.spawn_rate, args.duration, result_dir / "load.log", result_dir / "load")
            pg_pid = int((data_dir / "postmaster.pid").read_text().splitlines()[0])
            samplers = [CpuSampler(), CpuSampler(), CpuSampler()]
            samples = []
            while load.poll() is None:
                samples.append({
                    "utc": datetime.now(timezone.utc).isoformat(),
                    "api": process_usage(api.pid, samplers[0]), "postgres": process_usage(pg_pid, samplers[1]), "generator": process_usage(load.pid, samplers[2]),
                })
                time.sleep(1)
            load_code = load.wait()
            load_log.close()
            (result_dir / "resources.json").write_text(json.dumps(samples, indent=2), encoding="utf-8")
            stats = json.loads((result_dir / "locust_final.json").read_text(encoding="utf-8"))
            if stats.pop("phase", None) != "measured" or stats.get("stats_source") != "locust_quitting":
                raise RuntimeError("Final measured Locust statistics are missing or invalid")
            metadata["csv_snapshot"] = aggregated_stats(result_dir / "load_stats.csv")
            metadata["locust_exit_code"] = load_code
            metadata["results"] = stats
            metadata["ended_at_utc"] = datetime.now(timezone.utc).isoformat()
            metadata["threshold_exceeded"] = (stats["error_rate"] is None or stats["error_rate"] > 0.01 or stats["p95_ms"] is None or stats["p95_ms"] > 2000)
            if args.diagnostic:
                endpoint_data = json.loads((result_dir / "endpoint_final.json").read_text(encoding="utf-8"))
                if endpoint_data.get("phase") != "measured" or not endpoint_data.get("endpoints"):
                    raise RuntimeError("Missing final diagnostic endpoint statistics")
                endpoints = endpoint_data["endpoints"]
                if not observed_workload(args.profile, endpoints):
                    raise RuntimeError("Diagnostic workload did not exercise all required roles/methods")
                if sum(entry["requests"] for entry in endpoints) != stats["requests"] or sum(entry["failures"] for entry in endpoints) != stats["failures"]:
                    raise RuntimeError("Diagnostic final endpoint counters do not match aggregate")
                metadata["endpoint_limit_violations"] = exceeded_endpoints(endpoints, args.p95_limit_ms, args.owner_probe_limit_ms)
                metadata["threshold_exceeded"] = bool(metadata["endpoint_limit_violations"]) or stats["error_rate"] is None or stats["error_rate"] > 0.01 or stats["p95_ms"] is None or stats["p95_ms"] > args.p95_limit_ms
            metadata["status"] = "failed" if load_code else "completed"
            (result_dir / "manifest.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
            print(f"Saved Kaggle run evidence in {result_dir}; threshold_exceeded={metadata['threshold_exceeded']}")
            return 2 if metadata["threshold_exceeded"] or load_code else 0
        except BaseException:
            metadata["status"] = "failed"
            metadata["ended_at_utc"] = datetime.now(timezone.utc).isoformat()
            (result_dir / "manifest.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
            raise
        finally:
            for process in (load, warmup, api):
                stop_process(process)
            for log in (load_log, warmup_log, api_log):
                if log is not None:
                    log.close()
            if pg_started:
                command(prefix + [str(pg_bin / "pg_ctl"), "-D", str(data_dir), "-m", "immediate", "stop"])
            if pg_log.exists():
                shutil.copyfile(pg_log, result_dir / "postgres.log")


if __name__ == "__main__":
    raise SystemExit(main())
