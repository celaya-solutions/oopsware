"""Count recorded native-inventory delivery, including errors and file recovery.

Requires tiktoken==0.12.0 in the experiment environment. These are serialization
proxies, not model usage or a claim about a host's schema injection/rendering.
"""

import argparse
import json
from pathlib import Path
import sys

import tiktoken


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def inspect_case(path, encoding):
    report = json.loads((path / "report.json").read_text())
    transcript = json.loads((path / "transcript.json").read_text())
    catalog_text = (path / "catalog.json").read_text()
    catalog = json.loads(catalog_text)
    scope = next(
        json.loads(line)
        for line in reversed(path.with_suffix(".log").read_text().splitlines())
        if line.startswith('{"resource_scope":')
    )
    observation = scope.get("payload_resource_observation") or {}
    count = lambda value: len(encoding.encode(value, disallowed_special=()))
    input_projection = [
        {key: tool[key] for key in ["name", "description", "inputSchema"]}
        for tool in catalog["tools"]
    ]
    rpc = [event for event in transcript if "reply" in event or "failure" in event]
    local = [event for event in transcript if event["name"] == "local-bundle-projection"]
    arguments = sum(count(compact({"name": event["name"], "arguments": event["input"]})) for event in rpc)
    text = sum(
        count(item["text"])
        for event in rpc
        for item in event.get("reply", {}).get("content", [])
        if item["type"] == "text"
    )
    full_replies = sum(count(compact(event["reply"])) for event in rpc if "reply" in event)
    local_output = sum(count(compact(event["projection"])) for event in local)
    schemas = count(compact(input_projection))
    completed = (
        report["status"] == "passed"
        and len(report["tasks"]) == 2
        and not report["cleanup_failures"]
        and not report["receipt_failures"]
        and scope["abort"] is None
        and scope.get("payload_resource_observation_verified") is True
        and observation.get("payload_exit_code") == 0
        and observation.get("payload_cleanup_verified") is True
    )
    return {
        "recording": path.name,
        "status": report["status"],
        "completed_with_verified_cleanup": completed,
        "mode": report["mode"],
        "catalog_tools": len(catalog["tools"]),
        "catalog_bytes": len(catalog_text.encode()),
        "rpc_calls": len(rpc),
        "rpc_errors_or_rejections": sum(event.get("reply", {}).get("isError") is True or "failure" in event for event in rpc),
        "rpc_argument_bytes": sum(len(compact({"name": event["name"], "arguments": event["input"]}).encode()) for event in rpc),
        "rpc_reply_bytes": sum(call["reply_bytes"] or 0 for call in report["calls"]),
        "local_recoveries": report.get("local_recoveries", []),
        "token_estimates": {
            "catalog_full_json": count(catalog_text),
            "catalog_input_facing_projection": schemas,
            "rpc_name_and_argument_json": arguments,
            "rpc_text_content": text,
            "rpc_complete_result_json": full_replies,
            "local_projection_output_json": local_output,
            "input_facing_catalog_plus_arguments_text_and_local_output": schemas + arguments + text + local_output,
        },
        "whole_scope_wall_seconds": scope["elapsed_seconds"],
        "payload_family_cpu_seconds": observation["cpu_stat"]["usage_usec"] / 1_000_000 if observation.get("cpu_stat", {}).get("usage_usec") is not None else None,
        "kernel_family_peak_bytes_including_file_cache": observation.get("memory_peak_bytes"),
        "payload_exit_observation_verified": scope.get("payload_resource_observation_verified"),
        "observed_resource_events": observation.get("resource_events"),
        "final_whole_scope_events": scope.get("resource_events_final"),
        "tasks": [{"phase": task["phase"], "elapsed_ms": task["elapsed_ms"]} for task in report["tasks"]],
        "facts_sha256": report.get("facts_sha256"),
        "sources_sha256": report.get("sources_sha256"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("cases", type=Path, nargs="+")
    args = parser.parse_args()
    encoding = tiktoken.get_encoding("cl100k_base")
    result = {
        "python": sys.version,
        "tiktoken": tiktoken.__version__,
        "encoding": encoding.name,
        "actual_model_usage": None,
        "unmeasured": [
            "model-host schema selection, wrapping and rendering",
            "system prompts, local filesystem tool schema/program generation and follow-up reasoning",
            "model input/cached/uncached/output usage",
            "initialization and JSON-RPC wire framing",
            "isolated correctness-oracle CPU and memory overhead",
        ],
        "samples": [inspect_case(path, encoding) for path in args.cases],
    }
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"samples": len(result["samples"]), "encoding": encoding.name, "actual_model_usage": None}))


if __name__ == "__main__":
    main()
