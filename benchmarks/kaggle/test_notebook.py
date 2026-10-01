"""Exercise notebook failure handling and artifact export without a Kaggle machine."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
from datetime import datetime, timezone
import unittest
from unittest.mock import patch
import uuid
import zipfile

from metrics import BENCHMARK_PROTOCOL

NOTEBOOK = json.loads(Path(__file__).with_name("notebook.ipynb").read_text(encoding="utf-8"))


def test_directory():
    root = Path(__file__).resolve().parent
    temporary = tempfile.TemporaryDirectory(prefix="kaggle-test-", dir=root)
    assert Path(temporary.name).resolve().parent == root
    return temporary


class NotebookTests(unittest.TestCase):
    def context(self, root):
        return {"Path": Path, "json": json, "os": os, "re": re, "signal": signal,
                "subprocess": subprocess, "datetime": datetime, "timezone": timezone,
                "uuid": uuid, "zipfile": zipfile, "WORKING": root, "repo": root,
                "RUN_LABEL": "B1", "COMMIT_SHA": "1" * 40, "actual": "1" * 40,
                "PROTOCOL": BENCHMARK_PROTOCOL, "PROFILES": ("ReadHeavyUser",),
                "USER_LEVELS": (1,), "REPEATS": 2, "EXPECTED_RUNS": 2,
                "SPAWN_RATE": 5, "WARMUP_SECONDS": 45, "DURATION_SECONDS": 120,
                "sys": __import__("sys")}

    def cell(self, number, values):
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile("".join(NOTEBOOK["cells"][number]["source"]), f"cell-{number}", "exec"), values)

    def evidence(self, root):
        values = self.context(root)
        values["evidence"] = root / "evidence"
        values["evidence"].mkdir()
        (values["evidence"] / "notebook-summary.json").write_text(json.dumps({"attempted_runs": 2, "stop_reason": None}), encoding="utf-8")
        return values

    def manifest(self, values, name):
        folder = values["evidence"] / name
        folder.mkdir()
        data = {"status": "completed", "threshold_exceeded": False, "locust_exit_code": 0,
                "commit": values["actual"], "dirty_worktree": False, "benchmark_protocol": BENCHMARK_PROTOCOL,
                "results": {"stats_source": "locust_quitting", "requests": 120, "failures": 0, "achieved_rps": 1, "p95_ms": 10}}
        (folder / "manifest.json").write_text(json.dumps(data), encoding="utf-8")
        return folder

    def test_complete_export_and_repeated_export_preserve_the_original_zip(self):
        with test_directory() as temporary:
            values = self.evidence(Path(temporary))
            self.manifest(values, "run-1"); self.manifest(values, "run-2")
            self.cell(9, values)
            archive = values["archive"]
            original = archive.read_bytes()
            with zipfile.ZipFile(archive) as zipped:
                summary = json.loads(zipped.read("evidence/notebook-summary.json"))
                self.assertEqual(summary["result"], "COMPLETE_PASS")
                self.assertEqual(summary["passed_runs"], 2)
            self.cell(9, values)
            self.assertNotEqual(archive, values["archive"])
            self.assertEqual(archive.read_bytes(), original)

    def test_corrupt_manifest_still_exports_logs_without_claiming_success(self):
        with test_directory() as temporary:
            values = self.evidence(Path(temporary))
            folder = self.manifest(values, "run-1")
            (folder / "manifest.json").write_text("{broken", encoding="utf-8")
            (folder / "api.log").write_text("diagnostic", encoding="utf-8")
            self.cell(9, values)
            with zipfile.ZipFile(values["archive"]) as zipped:
                summary = json.loads(zipped.read("evidence/notebook-summary.json"))
                self.assertEqual(summary["result"], "PARTIAL_OR_FAILED")
                self.assertIn("evidence/run-1/api.log", zipped.namelist())

    def test_export_includes_final_counters_but_excludes_fixture_and_redacts_logs(self):
        with test_directory() as temporary:
            values = self.evidence(Path(temporary))
            folder = self.manifest(values, "run-1")
            (folder / "locust_final.json").write_text('{"requests":120}', encoding="utf-8")
            (folder / "fixture.json").write_text("private fixture", encoding="utf-8")
            (folder / ".env").write_text("private environment", encoding="utf-8")
            (folder / "setup.log").write_text('postgresql://user:secret@localhost/db Bearer private.token.value', encoding="utf-8")
            self.cell(9, values)
            with zipfile.ZipFile(values["archive"]) as zipped:
                names = zipped.namelist()
                self.assertIn("evidence/run-1/locust_final.json", names)
                self.assertFalse(any(name.endswith(("fixture.json", ".env")) for name in names))
                log = zipped.read("evidence/run-1/setup.log").decode()
                self.assertNotIn("secret", log); self.assertNotIn("private.token.value", log)
                self.assertIn("[REDACTED_DATABASE_URL]", log)

    def test_early_runner_error_is_recorded_even_without_a_manifest(self):
        with test_directory() as temporary:
            values = self.context(Path(temporary))
            class FailedProcess:
                def __init__(self, *args, **kwargs): kwargs["stdout"].write("PostgreSQL prerequisite missing\n")
                def wait(self): return 1
            with patch.object(subprocess, "check_output", side_effect=lambda args, **kwargs: "" if "status" in args else values["actual"]), patch.object(subprocess, "Popen", FailedProcess):
                self.cell(7, values)
            self.assertEqual(values["run_count"], 1)
            self.cell(9, values)
            with zipfile.ZipFile(values["archive"]) as zipped:
                self.assertTrue(any(name.endswith("-runner.log") for name in zipped.namelist()))
                summary = json.loads(zipped.read(f'{values["evidence"].name}/notebook-summary.json'))
                self.assertEqual(summary["result"], "PARTIAL_OR_FAILED")
                self.assertIn("exit 1", summary["stop_reason"])

    def test_interruption_signals_the_runner_and_retains_partial_evidence(self):
        with test_directory() as temporary:
            values = self.context(Path(temporary))
            class InterruptedProcess:
                pid = 12345
                calls = 0
                def __init__(self, *args, **kwargs): self.log = kwargs["stdout"]
                def poll(self): return None
                def wait(self, timeout=None):
                    self.calls += 1
                    if self.calls == 1: raise KeyboardInterrupt()
                    self.log.write("Runner cleanup finished\n"); return 130
            with patch.object(subprocess, "check_output", side_effect=lambda args, **kwargs: "" if "status" in args else values["actual"]), patch.object(subprocess, "Popen", InterruptedProcess), patch.object(os, "killpg", create=True) as kill:
                self.cell(7, values)
                kill.assert_called_once_with(12345, signal.SIGINT)
            self.cell(9, values)
            self.assertEqual(values["summary"]["result"], "PARTIAL_OR_FAILED")
            self.assertIn("dừng cell", values["summary"]["stop_reason"])


if __name__ == "__main__":
    unittest.main()
