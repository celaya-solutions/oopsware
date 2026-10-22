"""Actual Codex wire capture with a deterministic local SSE backend; no AI inference."""
import argparse
import http.server
import threading
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import time
import traceback
import subprocess


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--codex", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--input-profile", choices=["full", "compact"], default="full")
    parser.add_argument("--output-profile", choices=["full", "off"], default="full")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--oracle", type=Path, required=True)
    parser.add_argument("--expected-tools", type=int, default=210)
    parser.add_argument("--mode", choices=["complete", "selected", "summary"], required=True)
    parser.add_argument("--export", action="store_true")
    parser.add_argument("--question", choices=["identity", "dependency"], default="dependency")
    args = parser.parse_args()
    assert args.question != "identity" or args.mode != "selected"
    assert args.mode != "summary" or args.question == "identity"
    oracle=json.loads(args.oracle.read_text())
    target=str(args.input)
    assert args.input.is_absolute() and args.oracle.is_absolute() and args.output.is_absolute()
    assert hashlib.sha256(args.input.read_bytes()).hexdigest()==oracle["artifact_sha256"]
    def delivered(pieces):
        assert isinstance(pieces,str) and pieces.startswith("Wall time: "), pieces[:300]
        _,sep,payload=pieces.partition("Output:\n");assert sep
        value=json.loads(payload)
        return value["result"] if "result" in value and "normalized_result" not in value else value
    def outputs_of(body):
        return {item["call_id"]:delivered(item["output"]) for item in body.get("input",[]) if item.get("type")=="function_call_output"}
    steps=1+(args.mode=="selected")+args.export
    args.output.mkdir(mode=0o700)
    audit_home = args.output / "account"
    codex_state = audit_home / ".codex"
    mcp_home = audit_home / "mcp"
    workspace = audit_home / "workspace"
    for directory in [codex_state, mcp_home, workspace]:
        directory.mkdir(parents=True)
    captured = []
    class Capture(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            size = int(self.headers["Content-Length"])
            assert 0 < size <= 16 * 1024 * 1024
            assert self.headers.get("Content-Encoding", "identity") == "identity"
            body = json.loads(self.rfile.read(size))
            captured.append({"path": self.path, "body": body})
            (args.output / "model-requests.json").write_text(json.dumps(captured) + "\n")
            index = len(captured)
            names = [t.get("name", "") for ns in body.get("tools", []) if ns.get("type") == "namespace" and ns.get("name") == "mcp__rea_audit" for t in ns.get("tools", [])]
            assert index <= steps+1
            response_id=f"resp_local_{index}"
            if index <= steps:
                previous=outputs_of(body)
                if index==1:
                    operation="inspect_go_binary";arguments={"path":target}
                    if args.mode!="complete":arguments["detail"]="summary"
                elif args.mode=="selected" and index==2:
                    parent=previous["call_local_1"]["normalized_result"]["parent_evidence_id"]
                    operation="inspect_analysis_view";arguments={"source":{"kind":"retained-evidence","evidence_id":parent},"view":{"kind":"go","collection":"dependencies","paths":[oracle["dependency_path"]],"fields":["path","version","sum","replacement"],"offset":0,"limit":64}}
                else:
                    operation="export_evidence_bundle";arguments={"path":str(args.output/"evidence.json")}
                selected=[name for name in names if name.endswith(operation)];assert len(selected)==1
                item={"type":"function_call","id":f"fc_local_{index}","call_id":f"call_local_{index}","name":selected[0],"namespace":"mcp__rea_audit","arguments":json.dumps(arguments),"status":"completed"}
            else:
                item={"type":"message","id":"msg_local_done","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Scripted local Go metadata query complete.","annotations":[]}]}
            base = {"id": response_id, "object": "response", "model": body.get("model"), "status": "completed", "output": [item]}
            events = [
                {"type": "response.created", "response": {**base, "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress"}},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": base},
            ]
            wire = "".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(wire)))
            self.end_headers()
            self.wfile.write(wire)
    endpoint = http.server.HTTPServer(("127.0.0.1", 0), Capture)
    endpoint_thread = threading.Thread(target=endpoint.serve_forever, daemon=True)
    endpoint_thread.start()
    task_path = f"{args.node.parent}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    mcp_env = {"HOME": str(mcp_home), "PATH": task_path,
               "NODE_OPTIONS": "--max-old-space-size=2048", "UV_THREADPOOL_SIZE": "1",
               "REA_LOG_LEVEL": "silent", "REA_MCP_INPUT_SCHEMA_PROFILE": args.input_profile,
               "REA_MCP_OUTPUT_SCHEMA_PROFILE": args.output_profile}
    config = 'model_provider = "rea_capture"\nmodel = "rea-wire-probe"\n[analytics]\nenabled = false\n[mcp_servers.rea_audit]\n'
    config += f'command = {json.dumps(str(args.node))}\n'
    config += f'args = {json.dumps([str(args.runtime / "scripts/rea.mjs"), "mcp"])}\n'
    config += 'startup_timeout_sec = 60\ntool_timeout_sec = 60\n'
    config += '[mcp_servers.rea_audit.env]\n'
    config += ''.join(f'{key} = {json.dumps(value)}\n' for key, value in mcp_env.items())
    for name in ['inspect_go_binary','inspect_analysis_view','export_evidence_bundle']:
        config += f'[mcp_servers.rea_audit.tools.{name}]\napproval_mode = "approve"\noutput_token_limit = 30000\n'
    config += f'\n[model_providers.rea_capture]\nname = "Local scripted capture"\nbase_url = "http://127.0.0.1:{endpoint.server_port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n'
    (codex_state / "config.toml").write_text(config)
    (args.output / "declared-config.toml").write_text(config)
    environment = {"HOME": str(audit_home), "CODEX_HOME": str(codex_state), "PATH": task_path,
                   "NODE_OPTIONS": "--max-old-space-size=2048", "UV_THREADPOOL_SIZE": "1"}
    report = {"question": "Read embedded Go identity/counts or a selected dependency. Export is a separate task variant.",
              "client": "Codex app-server 0.163.0", "model_turns_started": 1, "backend": "local deterministic SSE fixture; no AI model or paid service",
              "actual_model_usage": None, "input_profile": args.input_profile,
              "output_profile": args.output_profile, "calls": [], "observations": [],
              "unexpected_server_requests": [], "cleanup_failures": []}
    client_version = subprocess.check_output([str(args.codex), "--version"], env=environment, cwd=workspace, text=True, timeout=10).strip()
    assert client_version == "codex-cli 0.163.0", client_version
    transcript = []
    pending = {}
    completed_turn = asyncio.Event()
    next_id = 0
    stderr = (args.output / "server.log").open("wb")
    process = await asyncio.create_subprocess_exec(str(args.codex), "app-server", "--stdio",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=stderr,
        cwd=workspace, env=environment, limit=16 * 1024 * 1024)

    async def send(message):
        encoded = (json.dumps(message, separators=(",", ":")) + "\n").encode()
        transcript.append({"direction": "client", "bytes": len(encoded), "message": message})
        process.stdin.write(encoded)
        await process.stdin.drain()

    async def read_messages():
        try:
            while line := await process.stdout.readline():
                value = json.loads(line)
                transcript.append({"direction": "server", "bytes": len(line), "message": value})
                if value.get("method") == "turn/completed":
                    report["turn"] = value["params"]["turn"]
                    completed_turn.set()
                if "id" in value and "method" not in value:
                    future = pending.pop(value["id"], None)
                    if future and not future.done():
                        future.set_result(value)
                elif "id" in value:
                    report["unexpected_server_requests"].append(value["method"])
                    await send({"id": value["id"], "error": {"code": -32601, "message": "Unexpected request in scripted metadata probe"}})
            raise RuntimeError("app-server stdout closed")
        except Exception as error:
            for future in pending.values():
                if not future.done():
                    future.set_exception(error)

    reader = asyncio.create_task(read_messages())

    async def request(method, params):
        nonlocal next_id
        assert method in ["initialize", "thread/start", "mcpServerStatus/list", "mcpServer/tool/call", "turn/start"]
        next_id += 1
        message = {"id": next_id, "method": method, "params": params}
        future = asyncio.get_running_loop().create_future()
        pending[next_id] = future
        start = time.monotonic()
        await send(message)
        reply = await asyncio.wait_for(future, 90)
        report["calls"].append({"method": method, "elapsed_ms": (time.monotonic() - start) * 1000,
                                "error": reply.get("error")})
        if "error" in reply:
            raise RuntimeError(json.dumps(reply["error"])[:4000])
        return reply["result"]

    try:
        await request("initialize", {"clientInfo": {"name": "rea_host_probe", "title": "REA host compatibility probe", "version": "1"},
                                     "capabilities": {"experimentalApi": True, "explicitGatewayOauth": True}})
        await send({"method": "initialized"})
        created = await request("thread/start", {"cwd": str(workspace), "ephemeral": True,
                    "approvalPolicy": "never", "sandbox": "read-only"})
        thread_id = created["thread"]["id"]
        assert not created["thread"].get("turns", [])
        inventory = await request("mcpServerStatus/list", {"threadId": thread_id,
                    "serverName": "rea_audit", "detail": "toolsAndAuthOnly", "limit": 10})
        assert inventory.get("nextCursor") is None
        assert len(inventory["data"]) == 1
        server = inventory["data"][0]
        assert server["name"] == "rea_audit" and server.get("toolsError") is None
        tools = list(server["tools"].values())
        names = [tool["name"] for tool in tools]
        assert len(names) == len(set(names)) == args.expected_tools
        assert "inspect_go_binary" in names
        output_schemas = sum(tool.get("outputSchema") is not None for tool in tools)
        assert output_schemas == (args.expected_tools if args.output_profile == "full" else 0)
        raw = json.dumps(inventory, separators=(",", ":"), ensure_ascii=False).encode()
        (args.output / "catalog.json").write_bytes(raw)
        report["catalog"] = {"tools": len(tools), "output_schemas": output_schemas,
                             "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                             "server_info": server.get("serverInfo"), "runtime_status": server.get("runtimeStatus")}
        await request("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": ("Read the embedded Go compiler, main module and embedded dependency count; state runtime dependency coverage." if args.question=="identity" else "Read the embedded Go compiler, main module and golang.org/x/crypto dependency and state runtime dependency coverage.")+" The local fixture scripts the required tools; no AI inference is used."}]})
        await asyncio.wait_for(completed_turn.wait(), 90)
        assert report["turn"]["status"] == "completed", report["turn"]
        assert len(captured)==steps+1
        outputs=outputs_of(captured[-1]["body"])
        assert len(outputs)==steps
        initial=outputs["call_local_1"]
        assert initial["normalized_result"]["artifact"]["sha256"]==oracle["artifact_sha256"]
        if args.question=="identity":
            info=initial["normalized_result"]["build_info"] if args.mode=="complete" else initial["normalized_result"]["summary"]["build_info"]
            count=len(info["module"]["dependencies"]) if args.mode=="complete" else info["module"]["available_counts"]["dependencies"]
            facts={"go_version":info["go_version"],"main":info["module"]["main"],"runtime_dependencies":"unknown","dependency_count":count}
            parent=initial["evidence_id"] if args.mode=="complete" else initial["normalized_result"]["parent_evidence_id"]
        elif args.mode=="complete":
            info=initial["normalized_result"]["build_info"]
            facts={"go_version":info["go_version"],"main":info["module"]["main"],"runtime_dependencies":"unknown","dependencies":[{"index":i,**d} for i,d in enumerate(info["module"]["dependencies"]) if d["path"]==oracle["dependency_path"]]}
            parent=initial["evidence_id"]
        else:
            info=initial["normalized_result"]["summary"]["build_info"]
            selected=outputs["call_local_2"]["normalized_result"]
            assert selected["coverage"]["exhausted"] and selected["source_coverage"]["runtime_dependencies"]=="unknown"
            facts={"go_version":info["go_version"],"main":info["module"]["main"],"runtime_dependencies":"unknown","dependencies":selected["page"]["rows"]}
            parent=initial["normalized_result"]["parent_evidence_id"]
        expected=({key:oracle["answer"][key] for key in ["go_version","main","runtime_dependencies"]}|{"dependency_count":oracle["dependency_count"]}) if args.question=="identity" else oracle["answer"]
        assert facts==expected
        report["question_kind"]=args.question
        if args.export:
            bundle=json.loads((args.output/"evidence.json").read_text());evidence=next(e for e in bundle["records"] if e["evidence_id"]==parent)
            assert evidence["normalized_result"]==json.loads(Path(oracle["complete_result_path"]).read_text())
        report["observations"]={"answer":facts,"parent_evidence_id":parent,"exported":args.export}
        report["captured_requests"]=len(captured)
        report["mode"]=args.mode
        report["request_tool_counts"] = [len(c["body"].get("tools", [])) for c in captured]
        assert not report["unexpected_server_requests"]
        assert hashlib.sha256(args.input.read_bytes()).hexdigest()==oracle["artifact_sha256"]
        report["status"] = "passed"
    except Exception:
        report["status"] = "failed"
        report["failure"] = traceback.format_exc()[-6000:]
    finally:
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), 15)
        except asyncio.TimeoutError:
            report["cleanup_failures"].append("app-server did not exit after stdin close; terminated owned process")
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        await reader
        # app-server can acknowledge exit before its MCP child finishes EOF
        # cleanup. Wait on the allocated resource scope; never target a PID.
        try:
            groups = [line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines()
                      if line.startswith("0::")]
            assert len(groups) == 1
            group = Path("/sys/fs/cgroup") / groups[0].lstrip("/")
            assert re.fullmatch(r"rea-efficiency-[0-9a-f]{32}\.scope", group.name)
            observer = os.getppid()
            observer_args = Path(f"/proc/{observer}/cmdline").read_bytes().split(b"\0")
            assert any(Path(os.fsdecode(value)).name == "resource_payload.py" for value in observer_args if value)
            expected = {os.getpid(), observer}
            until = time.monotonic() + 10
            while True:
                actors = {int(value) for value in (group / "cgroup.procs").read_text().splitlines()}
                assert expected <= actors
                remaining = sorted(actors - expected)
                if not remaining or time.monotonic() >= until:
                    break
                await asyncio.sleep(0.05)
            report["owned_scope_drain"] = {"remaining_processes": remaining}
            if remaining:
                report["cleanup_failures"].append("owned MCP child did not settle after app-server exit")
        except (OSError, ValueError, AssertionError) as error:
            report["owned_scope_drain"] = {"status": "unavailable", "reason": type(error).__name__}
            report["cleanup_failures"].append("allocated resource-scope cleanup could not be verified")
        endpoint.shutdown()
        endpoint.server_close()
        endpoint_thread.join(5)
        stderr.close()
        report["appserver_exit_code"] = process.returncode
        if process.returncode != 0:
            report["cleanup_failures"].append(f"app-server exit code: {process.returncode}")
        (args.output / "transcript.json").write_text(json.dumps(transcript) + "\n")
        (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({key: report.get(key) for key in ["status", "failure", "catalog", "observations", "cleanup_failures", "appserver_exit_code"]}))
    return 0 if report["status"] == "passed" and not report["cleanup_failures"] else 1


raise SystemExit(asyncio.run(main()))
