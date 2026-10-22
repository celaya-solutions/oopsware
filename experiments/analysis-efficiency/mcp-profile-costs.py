"""Summarize recorded Codex discovery tasks; tiktoken==0.12.0 is a proxy only."""
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
    completed = (report["status"] == "passed" and not report["cleanup_failures"]
                 and report["appserver_exit_code"] == 0 and scope["abort"] is None
                 and scope.get("payload_resource_observation_verified") is True
                 and observed.get("payload_cleanup_verified") is True
                 and observed.get("payload_exit_code") == 0)
    tools = list(catalog["data"][0]["tools"].values())
    messages = [event["message"] for event in transcript]
    ids = {m["id"] for m in messages if m.get("method") == "mcpServer/tool/call"}
    replies = [m["result"] for m in messages if m.get("id") in ids and "result" in m]
    arguments = [m["params"] for m in messages if m.get("method") == "mcpServer/tool/call"]
    count = lambda text: len(encoding.encode(text, disallowed_special=()))
    input_catalog = count(compact([{k: t[k] for k in ["name", "description", "inputSchema"]} for t in tools]))
    argument_tokens = sum(count(compact(a)) for a in arguments)
    text_tokens = sum(count(c["text"]) for r in replies for c in r["content"] if c["type"] == "text")
    return {
        "recording": path.name, "completed_with_verified_cleanup": completed,
        "input_profile": report["input_profile"], "output_profile": report["output_profile"],
        "catalog": report["catalog"], "calls": report["calls"],
        # Codex returns tools as a map; JSON member order varies by process.
        "catalog_semantic_sha256": hashlib.sha256(json.dumps(
            catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            allow_nan=False).encode()).hexdigest(),
        "digests": [r["structuredContent"]["result"]["server_identity"]["catalog"]["digests"] for r in replies],
        "token_proxy": {"input_facing_catalog": input_catalog, "arguments": argument_tokens,
                        "text_replies": text_tokens, "combined": input_catalog + argument_tokens + text_tokens,
                        "complete_discovered_catalog": count(compact(catalog))},
        "wall_seconds": scope["elapsed_seconds"],
        "cpu_seconds": observed["cpu_stat"]["usage_usec"] / 1e6,
        "kernel_family_peak_bytes_including_file_cache": observed.get("memory_peak_bytes"),
        "observed_resource_events": observed.get("resource_events"),
        "final_whole_scope_events": scope.get("resource_events_final"),
        "sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                   for p in [path / "report.json", path / "catalog.json", path / "transcript.json", log]},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("cases", type=Path, nargs="+")
    args = parser.parse_args()
    encoding = tiktoken.get_encoding("cl100k_base")
    records = [inspect(path, encoding) for path in args.cases]
    result = {"tiktoken": tiktoken.__version__, "encoding": encoding.name,
              "actual_model_usage": None,
              "unmeasured": ["actual host model schema injection and rendering", "model input/output/cached tokens", "model reasoning and application investigation"],
              "recordings": records}
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    assert all(r["completed_with_verified_cleanup"] for r in records)


if __name__ == "__main__":
    main()
