#!/usr/bin/env python3
"""Check verifier result/exit semantics with controlled replies, not real apps."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap


def write(root, name, source):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(source))


def check(arguments, root, case):
    shutil.copyfile(arguments.verifier, root / "probe.mjs")
    write(root, "package.json", '{"type":"module"}')
    write(root, "node_modules/playwright-core/package.json",
          '{"type":"module","exports":"./index.js"}')
    write(root, "node_modules/playwright-core/index.js", """
        let reads = 0;
        const page = {
          locator: () => ({ waitFor: async () => {} }),
          getByText: () => ({ waitFor: async () => {} }),
          async evaluate() {
            const after = reads++ > 0;
            return { title: 'controlled oracle', invalid_file_dialog: !after,
              unsaved_changes: after,
              diagram_svg_elements: after && process.env.REA_DRAWIO_ORACLE_CASE !== 'insertion-failure' ? 2 : 0,
              cells: 0 };
          },
        };
        export const _electron = { async launch() {
          return { process: () => ({exitCode: 0, signalCode: null}),
            firstWindow: async () => page, close: async () => {} };
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
    write(root, "dist/application/javascript/ElectronActiveObservationService.js", """
        export async function captureElectronScenario(provider, input) {
          const app = await provider.launch({});
          await app.close();
          const name = process.env.REA_DRAWIO_ORACLE_CASE;
          const capture = { actions: input.actions.map(action => ({...action,
            status: name === 'action-failure' ? 'failed' : 'completed'})),
            coverage: {}, retention: {}, ipc: {events: [], observed: 0, dropped: 0} };
          if (name === 'no-capture') return {ok: false, error: {reason: 'startup_failed'}};
          if (name === 'partial') return {ok: false, error: {reason: 'cleanup_failed',
            partialObservation: {capture}}};
          return {ok: true, value: {evidence_id: 'ev_controlled',
            normalized_result: capture}};
        }
    """)
    result = subprocess.run(
        [arguments.node, str(root / "probe.mjs"), "--runtime-root", str(root),
         "--executable", arguments.node, "--application", str(root),
         "--profile-root", str(root), "--dismiss-error", "--selector", "controlled"],
        env={**os.environ, "REA_DRAWIO_ORACLE_CASE": case},
        capture_output=True, text=True, timeout=15,
    )
    replies = []
    for line in result.stdout.splitlines():
        try:
            replies.append(json.loads(line))
        except ValueError:
            pass
    receipt = next((value for value in replies if "workflow_status" in value), None)
    expected_success = case == "complete"
    expected_provider = case not in ("partial", "no-capture")
    expected_actions = case not in ("action-failure", "no-capture")
    expected_inserted = case != "insertion-failure"
    matched = (
        (result.returncode == 0) is expected_success
        and receipt is not None
        and receipt["provider_ok"] is expected_provider
        and receipt["cleanup_verified"] is expected_provider
        and receipt["actions_completed"] is expected_actions
        and receipt["shape_inserted"] is expected_inserted
        and (receipt["workflow_status"] == "verified") is expected_success
    )
    return {"case": case, "exit_code": result.returncode,
            "expected_success": expected_success, "summary_present": receipt is not None,
            "matched_expected": matched}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("--verifier", type=Path,
                        default=Path(__file__).with_name("drawio-electron-lifecycle.mjs"))
    arguments = parser.parse_args()
    receipts = []
    with tempfile.TemporaryDirectory(prefix="rea-drawio-oracles-") as directory:
        for case in ("complete", "partial", "action-failure", "insertion-failure", "no-capture"):
            root = Path(directory) / case
            root.mkdir()
            receipts.append(check(arguments, root, case))
    print(json.dumps({"oracle_cases": receipts, "real_provider_verified": False}))
    assert all(receipt["matched_expected"] for receipt in receipts), receipts


if __name__ == "__main__":
    main()
