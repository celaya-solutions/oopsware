"""Exercise real Codex MCP discovery/calls without starting a model turn."""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import time
import traceback


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--codex", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--input-profile", choices=["full", "compact"], default="full")
    parser.add_argument("--output-profile", choices=["full", "off"], default="full")
    args = parser.parse_args()
    args.output.mkdir(mode=0o700)
    audit_home = args.output / "account"
    codex_state = audit_home / ".codex"
    mcp_home = audit_home / "mcp"
    workspace = audit_home / "workspace"
    for directory in [codex_state, mcp_home, workspace]:
        directory.mkdir(parents=True)
    task_path = f"{args.node.parent}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    mcp_env = {"HOME": str(mcp_home), "PATH": task_path,
               "NODE_OPTIONS": "--max-old-space-size=2048", "UV_THREADPOOL_SIZE": "1",
               "REA_LOG_LEVEL": "silent", "REA_MCP_INPUT_SCHEMA_PROFILE": args.input_profile,
               "REA_MCP_OUTPUT_SCHEMA_PROFILE": args.output_profile}
    config = '[analytics]\nenabled = false\n[mcp_servers.rea_audit]\n'
    config += f'command = {json.dumps(str(args.node))}\n'
    config += f'args = {json.dumps([str(args.runtime / "scripts/rea.mjs"), "mcp"])}\n'
    config += 'startup_timeout_sec = 60\ntool_timeout_sec = 60\n'
    config += '[mcp_servers.rea_audit.env]\n'
    config += ''.join(f'{key} = {json.dumps(value)}\n' for key, value in mcp_env.items())
    (codex_state / "config.toml").write_text(config)
    (args.output / "declared-config.toml").write_text(config)
    environment = {"HOME": str(audit_home), "CODEX_HOME": str(codex_state), "PATH": task_path,
                   "NODE_OPTIONS": "--max-old-space-size=2048", "UV_THREADPOOL_SIZE": "1"}
    report = {"question": "Discover the complete canonical tool catalog and report no-target session/cleanup state, selected provider, package version and catalog tool count twice.",
              "client": "Codex app-server 0.163.0", "model_turns_started": 0,
              "actual_model_usage": None, "input_profile": args.input_profile,
              "output_profile": args.output_profile, "calls": [], "observations": [],
              "unexpected_server_requests": [], "cleanup_failures": []}
    transcript = []
    pending = {}
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
                if "id" in value and "method" not in value:
                    future = pending.pop(value["id"], None)
                    if future and not future.done():
                        future.set_result(value)
                elif "id" in value:
                    report["unexpected_server_requests"].append(value["method"])
                    await send({"id": value["id"], "error": {"code": -32601, "message": "Unexpected request in read-only discovery probe"}})
            raise RuntimeError("app-server stdout closed")
        except Exception as error:
            for future in pending.values():
                if not future.done():
                    future.set_exception(error)

    reader = asyncio.create_task(read_messages())

    async def request(method, params):
        nonlocal next_id
        assert method in ["initialize", "thread/start", "mcpServerStatus/list", "mcpServer/tool/call"]
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
        assert len(names) == len(set(names)) == 209
        assert "binary_session" in names
        output_schemas = sum(tool.get("outputSchema") is not None for tool in tools)
        assert output_schemas == (209 if args.output_profile == "full" else 0)
        raw = json.dumps(inventory, separators=(",", ":"), ensure_ascii=False).encode()
        (args.output / "catalog.json").write_bytes(raw)
        report["catalog"] = {"tools": len(tools), "output_schemas": output_schemas,
                             "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                             "server_info": server.get("serverInfo"), "runtime_status": server.get("runtimeStatus")}
        version = json.loads((args.runtime / "package.json").read_text())["version"]
        for phase in ["first", "warm"]:
            reply = await request("mcpServer/tool/call", {"threadId": thread_id,
                        "server": "rea_audit", "tool": "binary_session", "arguments": {}})
            assert reply.get("isError") is not True
            structured = reply["structuredContent"]
            texts = [c["text"] for c in reply["content"] if c.get("type") == "text"]
            assert len(texts) == 1 and json.loads(texts[0]) == structured
            facts = structured["result"]
            assert facts["open"] is False and facts["cleanup_pending"] is False
            assert facts["analysis_provider_binding"] is None
            assert facts["server_identity"]["package"]["version"] == version
            assert facts["server_identity"]["catalog"]["counts"]["mcp_tools"] == 209
            report["observations"].append({"phase": phase, "open": facts["open"],
                "cleanup_pending": facts["cleanup_pending"], "selected_provider": facts["analysis_provider_binding"],
                "package_version": version, "catalog_tools": 209,
                "negotiated_protocol": facts["server_identity"]["negotiated_protocol_version"],
                "structured_bytes": len(json.dumps(structured, separators=(",", ":"), ensure_ascii=False).encode())})
        selected_facts = lambda observation: {key: value for key, value in observation.items()
                                              if key not in ["phase", "structured_bytes"]}
        assert selected_facts(report["observations"][0]) == selected_facts(report["observations"][1])
        assert not report["unexpected_server_requests"]
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
        stderr.close()
        report["appserver_exit_code"] = process.returncode
        if process.returncode != 0:
            report["cleanup_failures"].append(f"app-server exit code: {process.returncode}")
        (args.output / "transcript.json").write_text(json.dumps(transcript) + "\n")
        (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({key: report.get(key) for key in ["status", "failure", "catalog", "observations", "cleanup_failures", "appserver_exit_code"]}))
    return 0 if report["status"] == "passed" and not report["cleanup_failures"] else 1


raise SystemExit(asyncio.run(main()))
