#!/usr/bin/env python3
"""Check verifier exit semantics with controlled replies, not real providers/apps.

The JS case owns a short-lived Node child so the main process has exited while
the provider reply still reports incomplete cleanup. The CLI cases substitute
only Popen. These are negative-oracle regressions, not runtime compatibility or
performance evidence; real Joplin trials remain separately required.
"""

import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
from unittest.mock import patch


def write(root, name, text):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text))


def check_js(arguments, root, complete):
    shutil.copyfile(arguments.javascript, root / "probe.mjs")
    write(root, "package.json", '{"type":"module"}')
    write(root, "node_modules/playwright-core/package.json",
          '{"type":"module","exports":"./index.js"}')
    write(root, "node_modules/playwright-core/index.js", """
        import { spawn } from 'node:child_process';
        import { once } from 'node:events';
        export const _electron = { async launch() {
          const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'],
            { stdio: 'ignore' });
          await once(child, 'spawn');
          return { process: () => child, async close() {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, 'exit'); child.kill(); await exited;
          }};
        }};
    """)
    write(root, "dist/browser/PlaywrightElectronActiveProvider.js", """
        export class PlaywrightElectronActiveProvider {
          constructor(environment, launch) { this.launch = launch; }
        }
    """)
    write(root, "dist/browser/PlaywrightElectronActiveActions.js", """
        export const runWithExecutionLimits = operation => operation;
    """)
    write(root, "dist/application/javascript/ElectronActiveObservationService.js", f"""
        import {{ once }} from 'node:events';
        export async function captureElectronScenario(provider, input, options) {{
          const app = await provider.launch({{}});
          try {{
            void app.firstWindow();
            await once(options.signal, 'abort');
          }} finally {{ await app.close(); }}
          const error = Object.assign(new Error('controlled cancellation'), {{
            _tag: 'BrowserObservationError', reason: 'cancelled',
            userCategory: 'cancelled', cleanupIncomplete: {str(not complete).lower()},
            partialObservation: {{capture: {{application: {{}},
              actions: [{{status: 'cancelled'}}], coverage: {{}}, windows: [], limitations: []}}}}
          }});
          return {{ok: false, error}};
        }}
    """)
    result = subprocess.run(
        [arguments.node, str(root / "probe.mjs"), "--runtime-root", str(root),
         "--executable", arguments.node, "--application", str(root),
         "--profile-root", str(root), "--case", "window-wait"],
        capture_output=True, text=True, timeout=15,
    )
    receipts = [json.loads(line) for line in result.stdout.splitlines()]
    receipt = next(value for value in receipts if "cleanup_phase" in value)
    assert receipt["launched_process_exited"] is True
    assert receipt["cleanup_phase"] == ("verified" if complete else "unverified")
    assert (result.returncode == 0) is complete, (result.returncode, result.stdout, result.stderr)
    return {"verifier": "shared", "controlled_cleanup_complete": complete,
            "main_exited": True, "exit_code": result.returncode}


def check_cli(arguments, root, code, category, cleanup):
    spec = importlib.util.spec_from_file_location("cli_cancellation_probe", arguments.python)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    error = {"code": code, "category": category, "details": {"partial_observation": {
        "kind": "electron-active-observation", "capture": {
            "application": {"cleanup": cleanup}, "actions": [{"status": "cancelled"}]}}}}

    class ExitedCLI:
        def __init__(self, command, **options):
            request = json.loads(command[3])
            (Path(request["args"][-1]) / "log-main-process.txt").touch()
            self.returncode = None
            self.output = options["stdout"]

        def poll(self):
            return self.returncode

        def wait(self, timeout):
            raise subprocess.TimeoutExpired("controlled CLI", timeout)

        def send_signal(self, signal):
            self.output.write(json.dumps(error).encode())
            self.output.flush()
            self.returncode = 143

    supplied = argparse.Namespace(profile_root=root, node=arguments.node,
                                  runtime_root=root, executable=Path(arguments.node), application=root)
    output = io.StringIO()
    passed = True
    with patch.object(module.subprocess, "Popen", ExitedCLI), contextlib.redirect_stdout(output):
        try:
            module.run(supplied)
        except AssertionError:
            passed = False
    expected = code == "cancelled" and category == "cancelled" and cleanup == "terminated-owned-process"
    assert passed is expected, (code, category, cleanup, output.getvalue())
    receipt = json.loads(output.getvalue())
    assert receipt["exit_code"] == 143
    return {"verifier": "cli", "code": code, "category": category,
            "application_cleanup": cleanup, "accepted": passed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("--javascript", type=Path, default=Path(__file__).with_name("electron-cancellation.mjs"))
    parser.add_argument("--python", type=Path, default=Path(__file__).with_name("joplin-cli-cancellation.py"))
    arguments = parser.parse_args()
    receipts = []
    with tempfile.TemporaryDirectory(prefix="rea-cancellation-oracles-") as directory:
        root = Path(directory)
        for complete in (False, True):
            case = root / str(complete)
            case.mkdir()
            receipts.append(check_js(arguments, case, complete))
        for code, category, cleanup in [
            ("cleanup_incomplete", "cancelled", "unverified"),
            ("cleanup_incomplete", "cancelled", "terminated-owned-process"),
            ("cancelled", "execution_failure", "terminated-owned-process"),
            ("cancelled", "cancelled", "terminated-owned-process"),
        ]:
            receipts.append(check_cli(arguments, root, code, category, cleanup))
    print(json.dumps({"oracle_cases": receipts, "real_provider_verified": False}))


if __name__ == "__main__":
    main()
