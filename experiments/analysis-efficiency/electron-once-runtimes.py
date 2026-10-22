#!/usr/bin/env python3
"""Serial native/hooked producer controls; not real-application evidence."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hook-root", type=Path, required=True)
    parser.add_argument("--node", type=Path, action="append", required=True)
    parser.add_argument("--electron", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    arguments.output.mkdir(parents=True, exist_ok=True)
    packet = Path(tempfile.mkdtemp(prefix="native-once-", dir=arguments.output))
    stage = packet / "staged"
    module = stage / "node_modules/electron"
    module.mkdir(parents=True)
    fixture = module / "index.js"
    fixture.write_text(
        'const { EventEmitter } = require("node:events");\n'
        "module.exports = { app: new EventEmitter(), ipcMain: new EventEmitter() };\n"
    )
    sources = [
        arguments.hook_root / "scripts/electron-active-hook.cjs",
        arguments.hook_root / "scripts/electron-active-hook-boundaries.cjs",
        Path(__file__).with_name("electron-once-runtime.mjs"),
    ]
    pins = {path.name: sha256(path) for path in sources}
    pins["electron-fixture"] = sha256(fixture)
    for source in sources:
        shutil.copyfile(source, stage / source.name)
    engines = [(engine, False) for engine in arguments.node]
    if arguments.electron is not None:
        engines.append((arguments.electron, True))
    results = []
    for index, (engine, run_as_node) in enumerate(engines):
        selected = engine.absolute()
        environment = dict(os.environ)
        if run_as_node:
            environment["ELECTRON_RUN_AS_NODE"] = "1"
        execution = subprocess.run(
            [str(selected), str(stage / sources[-1].name), str(stage / sources[0].name)],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )
        (packet / f"engine-{index}.stdout").write_bytes(execution.stdout)
        (packet / f"engine-{index}.stderr").write_bytes(execution.stderr)
        receipt = {
            "selected_binary": str(engine),
            "absolute_binary": str(selected),
            "binary_sha256": sha256(selected),
            "electron_run_as_node": run_as_node,
            "exit_code": execution.returncode,
            "stdout_sha256": hashlib.sha256(execution.stdout).hexdigest(),
            "stderr_sha256": hashlib.sha256(execution.stderr).hexdigest(),
        }
        if execution.returncode == 0:
            receipt["result"] = json.loads(execution.stdout)
        results.append(receipt)
        report = {"hook_root": str(arguments.hook_root), "source_sha256": pins,
                  "engines": results, "scope": __doc__}
        (packet / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        if execution.returncode != 0:
            raise RuntimeError(f"Engine failed; preserved receipt at {packet}")
    print(json.dumps({"packet": str(packet), "engines": [
        {"node": row["result"]["node"], "electron": row["result"]["electron"],
         "cases": row["result"]["cases"],
         "disagreements": row["result"]["disagreements"]} for row in results
    ]}))


if __name__ == "__main__":
    main()
