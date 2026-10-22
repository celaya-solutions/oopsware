#!/usr/bin/env python3
"""Verify real Joplin cancellation through REA's compiled public CLI.

The selected runtime and app run normally. Fresh profiles and raw CLI output
remain local; the printed receipt distinguishes cancellation from cleanup.
"""

import argparse
import json
from pathlib import Path
import signal
import subprocess
import tempfile
import time


def run(arguments):
    profile = Path(tempfile.mkdtemp(prefix="joplin-cli-", dir=arguments.profile_root))
    stdout_path = profile / "verifier-stdout.json"
    stderr_path = profile / "verifier-stderr.txt"
    request = {
        "executable_path": str(arguments.executable.resolve()),
        "application_path": str(arguments.application.resolve()),
        "args": ["--no-sandbox", "--disable-gpu", f"--user-data-dir={profile}/chromium",
                 "--profile", str(profile)],
        "actions": [{"step_id": "settle", "kind": "wait", "duration_ms": 60_000}],
    }
    started = time.monotonic()
    cancelled = None
    response_at = None
    failure = None
    signals = []
    with stdout_path.open("wb") as output, stderr_path.open("wb") as errors:
        process = subprocess.Popen(
            [arguments.node, str(arguments.runtime_root.resolve() / "scripts/rea.mjs"),
             "capture-electron-scenario", json.dumps(request), "--json"],
            stdin=subprocess.DEVNULL, stdout=output, stderr=errors,
        )
        try:
            readiness_deadline = started + 70
            while not (profile / "log-main-process.txt").exists():
                if process.poll() is not None:
                    raise RuntimeError(f"CLI exited before application startup: {process.returncode}")
                if time.monotonic() > readiness_deadline:
                    raise TimeoutError("No real Joplin startup log within 70 seconds")
                time.sleep(0.1)
            # This only schedules cancellation. The returned action, not this
            # delay, proves whether cancellation actually reached the wait.
            try:
                process.wait(timeout=3)
                raise RuntimeError("CLI exited before the cancellation signal")
            except subprocess.TimeoutExpired:
                pass
            cancelled = time.monotonic()
            signals.append("request SIGTERM")
            process.send_signal(signal.SIGTERM)
            deadline = cancelled + 20
            previous_size = 0
            while process.poll() is None:
                size = stdout_path.stat().st_size
                if response_at is None and size != previous_size:
                    previous_size = size
                    try:
                        published = json.loads(stdout_path.read_text())
                        if isinstance(published, dict) and "code" in published:
                            response_at = time.monotonic()
                    except json.JSONDecodeError:
                        pass
                if time.monotonic() > deadline:
                    raise TimeoutError("CLI did not exit within 20 seconds after request SIGTERM")
                time.sleep(0.05)
        except Exception as cause:
            failure = cause
        finally:
            if process.poll() is None:
                signals.append("verifier recovery SIGTERM")
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    signals.append("verifier recovery SIGKILL")
                    process.kill()
                    process.wait()
    error = json.loads(stdout_path.read_text()) if stdout_path.stat().st_size else {}
    partial = error.get("details", {}).get("partial_observation", {})
    capture = partial.get("capture", {})
    cancelled_action = any(action["status"] == "cancelled" for action in capture.get("actions", []))
    receipt = {
        "request": request,
        "exit_code": process.returncode,
        "elapsed_seconds": time.monotonic() - started,
        "cancellation_to_observation_end_seconds": None if cancelled is None else time.monotonic() - cancelled,
        "cancellation_to_response_seconds": None if response_at is None else response_at - cancelled,
        "signals": signals,
        "verifier_failure": None if failure is None else str(failure),
        "code": error.get("code"), "category": error.get("category"),
        "cancelled_action": cancelled_action,
        "application": capture.get("application"),
        "actions": capture.get("actions"), "coverage": capture.get("coverage"),
        "stdout_bytes": stdout_path.stat().st_size,
        "stderr_bytes": stderr_path.stat().st_size,
        "stdout_path": str(stdout_path), "stderr_path": str(stderr_path),
        "cleanup_verified": error.get("code") == "cancelled" and
                            capture.get("application", {}).get("cleanup") == "terminated-owned-process",
    }
    print(json.dumps(receipt))
    if failure is not None:
        raise failure
    assert process.returncode == 143, "CLI must retain its SIGTERM exit convention"
    assert partial.get("kind") == "electron-active-observation"
    assert cancelled_action, "Startup alone does not establish action cancellation"
    assert error.get("category") == "cancelled"
    assert receipt["cleanup_verified"], "Cancellation alone does not establish complete provider cleanup"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--application", type=Path, required=True)
    parser.add_argument("--profile-root", type=Path, required=True)
    run(parser.parse_args())
