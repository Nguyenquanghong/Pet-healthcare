import json
from pathlib import Path
import unittest
import zipfile
from unittest.mock import patch
import subprocess

from diagnostics import DIAGNOSTIC_PROTOCOL, build_plan, exceeded_endpoints, observed_workload
from diagnostic_report import export
import test_notebook
from test_notebook import test_directory


class DiagnosticTests(unittest.TestCase):
    def test_diagnostic_notebook_stops_on_runner_error_and_exports_partial_plan(self):
        notebook = json.loads(Path(__file__).with_name("notebook_diagnostics.ipynb").read_text(encoding="utf-8"))
        with test_directory() as directory:
            values = test_notebook.NotebookTests().context(Path(directory))
            values.update({"SUITE": "data", "PROTOCOL": DIAGNOSTIC_PROTOCOL, "RUN_LABEL": "B1D",
                           "P95_LIMIT_MS": 2000, "OWNER_PROBE_LIMIT_MS": 500})
            launches = []
            class FailedRunner:
                def __init__(self, args, **kwargs):
                    launches.append(args)
                    kwargs["stdout"].write("Port in use\n")
                def wait(self): return 1
            def command(args, **kwargs):
                if "status" in args: return ""
                if "rev-parse" in args: return values["actual"]
                return json.dumps(build_plan("data"))
            with patch.object(subprocess, "check_output", side_effect=command), patch.object(subprocess, "Popen", FailedRunner):
                import contextlib, io
                with contextlib.redirect_stdout(io.StringIO()):
                    exec(compile("".join(notebook["cells"][7]["source"]), "diagnostic-cell-7", "exec"), values)
            self.assertEqual(len(launches), 1)
            self.assertIn("--diagnostic", launches[0])
            self.assertIn("--history-rows", launches[0])
            summary, archive = export(values["evidence"])
            self.assertEqual(summary["result"], "RUN_ERROR_OR_PARTIAL")
            self.assertEqual(summary["attempted_runs"], 1)
            self.assertEqual(summary["expected_runs"], 6)
            self.assertTrue(archive.is_file())

    def test_load_sweep_does_not_change_dataset_and_ramp_is_budgeted(self):
        for suite in ("data", "interference", "stress", "soak"):
            plan = build_plan(suite)
            self.assertEqual(len({c["name"] for c in plan}), len(plan))
            self.assertEqual({c["fixture_users"] for c in plan}, {500})
            for c in plan:
                self.assertGreaterEqual(c["warmup_seconds"], c["users"] / c["spawn_rate"] + 15)
                self.assertGreaterEqual(c["duration_seconds"], c["users"] / c["spawn_rate"] + 300)
            if suite != "data":
                self.assertEqual({c["history_rows"] for c in plan}, {10000})
        pair = build_plan("interference")
        self.assertEqual([c["users"] for c in pair], [50, 55, 55, 50])
        self.assertTrue(all(c["owner_users"] == 50 for c in pair))

    def test_owner_regression_is_detected_even_with_fast_admin_requests(self):
        entries = [{"name": "ADMIN GET /api/bootstrap", "error_rate": 0, "p95_ms": 100},
                   {"name": "OWNER probe GET /api/pets", "error_rate": 0, "p95_ms": 510}]
        self.assertEqual(exceeded_endpoints(entries), ["OWNER probe GET /api/pets"])

    def test_interference_requires_both_roles_and_mixed_requires_writes(self):
        owner = {"name": "OWNER probe GET /api/pets", "method": "GET", "requests": 100}
        self.assertFalse(observed_workload("AdminInterference", [owner]))
        self.assertTrue(observed_workload("AdminInterference", [owner, {"name": "ADMIN GET /api/bootstrap", "requests": 5}]))
        self.assertFalse(observed_workload("MixedUser", [owner]))

    def evidence(self, root, plan=None):
        root = Path(root) / "evidence"
        root.mkdir()
        plan = plan or build_plan("interference")[:2]
        summary = {"commit": "1" * 40, "label": "B1D", "benchmark_protocol": DIAGNOSTIC_PROTOCOL,
                   "plan": plan, "expected_runs": len(plan), "attempted_runs": len(plan), "stop_reason": None}
        (root / "notebook-summary.json").write_text(json.dumps(summary), encoding="utf-8")
        for case in plan:
            folder = root / f'B1D_{case["name"]}'
            folder.mkdir()
            p95 = 20 if case["profile"] == "AdminInterference" else 10
            result = {"stats_source": "locust_quitting", "requests": 100, "failures": 0, "error_rate": 0,
                      "achieved_rps": 1, "p50_ms": 5, "p95_ms": p95, "p99_ms": p95}
            endpoints = [{"method": "GET", "name": "OWNER probe GET /api/pets", **result, "mean_response_bytes": 123}]
            if case["profile"] == "AdminInterference":
                endpoints.append({**endpoints[0], "name": "ADMIN GET /api/bootstrap", "requests": 5})
                result["requests"] += 5
            manifest = {"commit": summary["commit"], "dirty_worktree": False, "benchmark_protocol": DIAGNOSTIC_PROTOCOL,
                        "profile": case["profile"], "users": case["users"], "history_episodes": case["history_rows"],
                        "fixture_owners_and_pets": case["fixture_users"], "duration": f'{case["duration_seconds"]}s',
                        "warmup": f'{case["warmup_seconds"]}s', "spawn_rate_per_second": case["spawn_rate"],
                        "owner_users": case["owner_users"], "admin_users": case["admin_users"],
                        "cpu_model": "test", "cpu_count": 4, "cpu_affinity": [0, 1, 2, 3], "memory_total_bytes": 32000000000,
                        "node_version": "24", "postgres_version": "14", "locust_version": "2.44.4",
                        "status": "completed", "locust_exit_code": 0, "threshold_exceeded": False, "results": result}
            (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (folder / "locust_final.json").write_text(json.dumps({"phase": "measured", **result}), encoding="utf-8")
            (folder / "endpoint_final.json").write_text(json.dumps({"phase": "measured", "endpoints": endpoints}), encoding="utf-8")
        return root, plan

    def test_export_matches_control_pairs_and_preserves_previous_archive(self):
        with test_directory() as directory:
            root, _ = self.evidence(directory)
            summary, archive = export(root)
            self.assertEqual(summary["result"], "COMPLETED_WITHIN_LIMITS")
            self.assertEqual(summary["interference_comparisons"][0]["p95_ratio"], 2)
            _, second = export(root)
            self.assertNotEqual(archive, second)
            self.assertTrue(archive.is_file())

    def test_wrong_final_counters_or_source_cannot_claim_complete(self):
        for fault in ("counter", "commit"):
            with self.subTest(fault=fault), test_directory() as directory:
                root, plan = self.evidence(directory)
                folder = root / f'B1D_{plan[0]["name"]}'
                file = folder / ("locust_final.json" if fault == "counter" else "manifest.json")
                data = json.loads(file.read_text())
                data["requests" if fault == "counter" else "commit"] = 999 if fault == "counter" else "2" * 40
                file.write_text(json.dumps(data), encoding="utf-8")
                summary, _ = export(root)
                self.assertEqual(summary["result"], "RUN_ERROR_OR_PARTIAL")
                self.assertEqual(summary["interference_comparisons"], [])

    def test_limit_reached_is_exported_without_exposing_fixture_secrets(self):
        with test_directory() as directory:
            root, plan = self.evidence(directory)
            folder = root / f'B1D_{plan[0]["name"]}'
            manifest = json.loads((folder / "manifest.json").read_text())
            manifest["threshold_exceeded"] = True
            (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (folder / "fixture.json").write_text("SECRET", encoding="utf-8")
            (folder / ".env").write_text("SECRET", encoding="utf-8")
            (root / "early-runner.log").write_text("postgresql://user:SECRET@localhost/db Bearer SECRET", encoding="utf-8")
            summary, archive = export(root)
            self.assertEqual(summary["result"], "LIMIT_REACHED")
            with zipfile.ZipFile(archive) as output:
                self.assertFalse(any(n.endswith(("fixture.json", ".env")) for n in output.namelist()))
                self.assertNotIn("SECRET", output.read("evidence/early-runner.log").decode())

    def test_prerequisite_failure_exports_log_and_not_run_cases(self):
        with test_directory() as directory:
            root = Path(directory) / "evidence"
            root.mkdir()
            (root / "notebook-summary.json").write_text(json.dumps({"commit": "1" * 40, "label": "B1D",
                "benchmark_protocol": DIAGNOSTIC_PROTOCOL, "plan": build_plan("stress"), "expected_runs": 8,
                "attempted_runs": 1, "stop_reason": "Port is in use"}), encoding="utf-8")
            (root / "B1D_mixed_100_r1-runner.log").write_text("Port is in use", encoding="utf-8")
            summary, archive = export(root)
            self.assertEqual(summary["result"], "RUN_ERROR_OR_PARTIAL")
            self.assertEqual(summary["verified_runs"], 0)
            with zipfile.ZipFile(archive) as output:
                self.assertIn("evidence/B1D_mixed_100_r1-runner.log", output.namelist())


if __name__ == "__main__":
    unittest.main()
