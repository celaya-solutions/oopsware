"""Count entire captured Codex request sequences, without claiming model usage."""
import argparse
import hashlib
import json
from pathlib import Path

import tiktoken


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def request_text(body):
    pieces = []
    if isinstance(body.get("instructions"), str):
        pieces.append(body["instructions"])
    for item in body.get("input", []):
        kind = item.get("type")
        if kind == "function_call_output":
            pieces.append(item["output"])
        elif kind == "function_call":
            pieces.append(item["arguments"])
        elif kind == "message" or "role" in item:
            for part in item.get("content", []):
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    pieces.append(part["text"])
    return pieces


def inspect(root, encoding):
    report = json.loads((root / "report.json").read_text())
    assert (report["status"] == "passed" and not report["cleanup_failures"]
            and report["appserver_exit_code"] == 0)
    requests = json.loads((root / "model-requests.json").read_text())
    whole, namespaces, texts = [], [], []
    count = lambda value: len(encoding.encode(value, disallowed_special=()))
    for event in requests:
        body = event["body"]
        whole.append(count(compact(body)))
        namespace = next(tool for tool in body["tools"]
                         if tool.get("type") == "namespace"
                         and tool["name"] == "mcp__rea_audit")
        namespaces.append(count(compact(namespace)))
        texts.append(sum(count(piece) for piece in request_text(body)))
    log = root.with_suffix(".log")
    scope = next(json.loads(line) for line in reversed(log.read_text().splitlines())
                 if line.startswith('{"resource_scope":'))
    observed = scope["payload_resource_observation"]
    assert (scope["abort"] is None and scope["payload_resource_observation_verified"]
            and observed["payload_cleanup_verified"] and observed["payload_exit_code"] == 0)
    memory = observed["resource_events"]["memory.events"]
    assert all(memory[key] == 0 for key in ["high", "max", "oom", "oom_kill"])
    assert observed["resource_events"]["pids.events"]["max"] == 0
    return {"case": root.name, "question": report["question_kind"],
            "request_count": len(requests), "whole_request_json_proxy": whole,
            "whole_request_json_proxy_sum": sum(whole),
            "rea_namespace_json_proxy": namespaces,
            "rea_namespace_json_proxy_sum": sum(namespaces),
            "unescaped_instruction_and_input_text_proxy": texts,
            "rea_namespace_plus_text_proxy_sum": sum(namespaces) + sum(texts),
            "wall_seconds": scope["elapsed_seconds"],
            "family_cpu_seconds": observed["cpu_stat"]["usage_usec"] / 1e6,
            "family_peak_mib": observed["memory_peak_bytes"] / 2**20,
            "completed_with_verified_cleanup": True,
            "sha256": {file.name: hashlib.sha256(file.read_bytes()).hexdigest()
                       for file in [root / "report.json", root / "model-requests.json",
                                    root / "transcript.json", log]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("cases", type=Path, nargs="+")
    args = parser.parse_args()
    encoding = tiktoken.get_encoding("cl100k_base")
    receipt = {"actual_model_usage": None,
               "backend": "deterministic local Responses SSE; no AI inference or paid service; not a model-quality or billing test",
               "client": "Codex app-server 0.163.0", "tiktoken": tiktoken.__version__,
               "encoding": encoding.name,
               "records": [inspect(root, encoding) for root in args.cases]}
    args.output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
