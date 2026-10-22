"""Count verified Go tasks; tokenizer estimates are not model usage or billing."""
import argparse
import hashlib
import json
from pathlib import Path

import tiktoken


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def inspect(path, encoding):
    report = json.loads((path / "report.json").read_text())
    catalog = json.loads((path / "catalog.json").read_text())
    transcript = json.loads((path / "transcript.json").read_text())
    log = path.with_suffix(".log")
    scope = next(json.loads(line) for line in reversed(log.read_text().splitlines())
                 if line.startswith('{"resource_scope":'))
    observed = scope.get("payload_resource_observation") or {}
    events = observed.get("resource_events", {})
    memory = events.get("memory.events", {})
    verified = (report["status"] == "observed"
                and not report["cleanup_failures"] and not report["receipt_failures"]
                and scope["abort"] is None
                and scope.get("payload_resource_observation_verified") is True
                and observed.get("payload_cleanup_verified") is True
                and observed.get("payload_exit_code") == 0
                and all(memory.get(key) == 0 for key in ["high", "max", "oom", "oom_kill"])
                and events.get("pids.events", {}).get("max") == 0)
    count = lambda value: len(encoding.encode(value, disallowed_special=()))
    inputs = count(compact([{key: tool[key] for key in ["name", "description", "inputSchema"]}
                            for tool in catalog["tools"]]))
    arguments = sum(count(compact({"name": event["name"], "arguments": event["input"]}))
                    for event in transcript)
    replies = sum(count(block["text"]) for event in transcript
                  for block in event["reply"]["content"] if block["type"] == "text")
    cpu = observed.get("cpu_stat", {}).get("usage_usec")
    return {"case": path.name, "completed_with_verified_cleanup": verified,
            "mode": report["mode"], "warm_diagnostic": report["warm_diagnostic"],
            "answer": report["answer"], "parent_evidence_id": report["parent_evidence_id"],
            "artifact_sha256": report["artifact_sha256"],
            "complete_result_sha256": report["complete_result_file_sha256"],
            "calls": report["calls"], "wall_seconds": scope["elapsed_seconds"],
            "cpu_seconds": None if cpu is None else cpu / 1e6,
            "kernel_family_peak_bytes": observed.get("memory_peak_bytes"),
            "events_at_payload_exit": events,
            "final_whole_scope_events": scope.get("resource_events_final"),
            "token_proxy": {"input_catalog": inputs, "arguments": arguments,
                            "text_replies": replies, "combined": inputs + arguments + replies,
                            "complete_transport_catalog": count(compact(catalog))},
            "sha256": {file.name: hashlib.sha256(file.read_bytes()).hexdigest()
                       for file in [path / "report.json", path / "catalog.json",
                                    path / "transcript.json", log]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("cases", type=Path, nargs="+")
    args = parser.parse_args()
    encoding = tiktoken.get_encoding("cl100k_base")
    records = [inspect(path, encoding) for path in args.cases]
    receipt = {"tiktoken": tiktoken.__version__, "encoding": encoding.name,
               "actual_model_usage": None,
               "projection": "All discovered input schemas once, plus every call's arguments and text replies, including export. Full transport catalog counted separately; no model turn or host injection measured.",
               "recordings": records}
    args.output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    assert all(record["completed_with_verified_cleanup"] for record in records)


if __name__ == "__main__":
    main()
