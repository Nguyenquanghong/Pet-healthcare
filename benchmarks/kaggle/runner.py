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
import socket
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import psutil
from metrics import CpuSampler


def command(args, *, cwd=None, env=None, stdout=None):
    return subprocess.run(args, cwd=cwd, env=env, stdout=stdout, stderr=subprocess.STDOUT if stdout else None, check=True, text=True)


def output(args, *, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def require_free_port(port):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))


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
    args = ["locust", "-f", str(repo / "benchmarks/kaggle/locustfile.py"), profile,
            "--headless", "--only-summary", "--host", "http://127.0.0.1:5001",
            "--users", str(users), "--spawn-rate", str(spawn_rate), "--run-time", duration]
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
    parser.add_argument("--profile", choices=["ReadHeavyUser", "MixedUser"], required=True)
    parser.add_argument("--users", type=int, required=True)
    parser.add_argument("--spawn-rate", type=float, default=5)
    parser.add_argument("--warmup", default="30s")
    parser.add_argument("--duration", default="2m")
    parser.add_argument("--seed", default="phase1")
    args = parser.parse_args()

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
    for program in ("node", "npm", "locust", "pg_config", "psql", "createdb"):
        if not shutil.which(program):
            raise RuntimeError(f"Missing {program}; install it in this Kaggle session before the run")
    pg_bin = Path(output(["pg_config", "--bindir"]))
    for program in ("initdb", "pg_ctl"):
        if not (pg_bin / program).is_file():
            raise RuntimeError(f"Missing PostgreSQL binary: {pg_bin / program}")
    require_free_port(55432)
    require_free_port(5001)
    result_dir.mkdir(parents=True, exist_ok=False)

    metadata = {
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "commit": output(["git", "rev-parse", "HEAD"], cwd=repo),
        "dirty_worktree": bool(output(["git", "status", "--porcelain"], cwd=repo)),
        "platform": platform.platform(),
        "cpu_count": psutil.cpu_count(logical=True),
        "memory_total_bytes": psutil.virtual_memory().total,
        "node_version": output(["node", "--version"]),
        "npm_version": output(["npm", "--version"]),
        "postgres_version": output([str(pg_bin / "postgres"), "--version"]),
        "locust_version": output(["locust", "--version"]),
        "profile": args.profile,
        "users": args.users,
        "spawn_rate_per_second": args.spawn_rate,
        "warmup": args.warmup,
        "duration": args.duration,
        "fixture_seed": args.seed,
        "fixture_owners_and_pets": max(100, args.users),
        "wait_seconds_uniform": [0.5, 1.5],
        "task_weights": ({"GET bootstrap": 40, "GET pets": 25, "GET appointments": 20, "GET notifications": 15}
                         if args.profile == "ReadHeavyUser" else
                         {"GET bootstrap": 30, "GET pets": 20, "GET appointments": 15, "GET notifications": 5, "POST rescue report": 20, "POST appointment": 10}),
        "stop_conditions": {"error_rate_gt": 0.01, "p95_ms_gt": 2000},
        "offered_rps": None,
        "load_model": "closed-loop users with think time; independent offered RPS is not defined",
        "generator_shares_cpu": True,
        "resource_sampling": "CPU time deltas, first sample null; short-lived processes between polls may be missed; RSS sums can include shared pages",
        "status": "running",
    }
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
            environment["DATABASE_URL"] = "postgresql://postgres@127.0.0.1:55432/nipopeto?schema=public"
            environment["JWT_SECRET"] = secrets.token_urlsafe(40)
            environment["PORT"] = "5001"
            environment["BENCH_FIXTURE"] = str(fixture_path)
            environment["BENCH_PASSWORD"] = secrets.token_urlsafe(24)
            environment["BENCH_USERS"] = str(max(100, args.users))
            environment["BENCH_SEED"] = args.seed
            environment["BENCH_SEED_NUMBER"] = "20260923"
            with open(result_dir / "setup.log", "a", encoding="utf-8") as setup_log:
                command(["npm", "ci"], cwd=repo, env=environment, stdout=setup_log)
                command(["npm", "run", "build", "-w", "backend"], cwd=repo, env=environment, stdout=setup_log)
                command(["npm", "run", "db:deploy", "-w", "backend"], cwd=repo, env=environment, stdout=setup_log)
            api_log = open(result_dir / "api.log", "w", encoding="utf-8")
            api = subprocess.Popen(["npm", "run", "start", "-w", "backend"], cwd=repo, env=environment, stdout=api_log, stderr=subprocess.STDOUT, start_new_session=True)
            wait_health(5001, api)
            with open(result_dir / "setup.log", "a", encoding="utf-8") as setup_log:
                command(["node", str(repo / "benchmarks/kaggle/prepare_fixture.mjs")], cwd=repo, env=environment, stdout=setup_log)

            environment["BENCH_PHASE"] = "warmup"
            warmup, warmup_log = run_locust(repo, environment, args.profile, args.users, args.spawn_rate, args.warmup, result_dir / "warmup.log")
            warmup_code = warmup.wait()
            warmup_log.close()
            if warmup_code != 0:
                raise RuntimeError(f"Locust warmup exited {warmup_code}; inspect warmup.log")

            environment["BENCH_PHASE"] = "measured"
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
            stats = aggregated_stats(result_dir / "load_stats.csv")
            metadata["locust_exit_code"] = load_code
            metadata["results"] = stats
            metadata["ended_at_utc"] = datetime.now(timezone.utc).isoformat()
            metadata["threshold_exceeded"] = (stats["error_rate"] is None or stats["error_rate"] > 0.01 or stats["p95_ms"] > 2000)
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
