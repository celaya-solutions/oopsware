"""Pin a completed Go report only after checking native build text and file bytes."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--go", type=Path, required=True)
    parser.add_argument("--dependency", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = args.input.read_bytes()
    evidence = json.loads(args.evidence.read_text())
    if "records" in evidence:
        evidence = next(record for record in evidence["records"]
                        if record["operation"] == "inspect_go_binary"
                        and record["parameters"] == {"path": str(args.input)})
    report = evidence["normalized_result"]
    info = report["build_info"]
    digest = hashlib.sha256(source).hexdigest()
    assert report["artifact"] == {"path": str(args.input), "sha256": digest,
                                  "bytes": len(source)}
    native = subprocess.check_output(
        [str(args.go), "version", "-m", str(args.input)], text=True)
    lines = native.splitlines()
    assert info["go_version"] == lines[0].rsplit(" ", 1)[1]
    text = "\n".join(line.removeprefix("\t") for line in lines[1:]) + "\n"
    assert info["module_text"] == text
    for name in ["version", "module"]:
        location = info[name + "_location"]
        key = ("go_version" if name == "version" else "module") + "_bytes_base64"
        assert source[location["offset"]:location["offset"] + location["bytes"]] == base64.b64decode(info[key])
    # Module identity columns are literal tab-separated fields. Preserve empty
    # sums, development versions, original ordering and local replacements.
    dependencies = []
    main_module = None
    previous = None
    for line in text.splitlines():
        columns = line.split("\t")
        tag = columns[0]
        if tag not in ["dep", "mod", "=>"]:
            continue
        assert len(columns) in [3, 4], columns
        item = {"path": columns[1], "version": columns[2],
                "sum": columns[3] if len(columns) == 4 else None}
        if tag == "=>":
            assert previous is not None
            previous["replacement"] = item
        else:
            item["replacement"] = None
            previous = item
            if tag == "mod":
                main_module = item
            else:
                dependencies.append(item)
    assert info["module"]["main"] == main_module
    assert info["module"]["dependencies"] == dependencies
    answer = {"go_version": info["go_version"], "main": main_module,
              "runtime_dependencies": "unknown",
              "dependencies": [{"index": index, **item}
                               for index, item in enumerate(dependencies)
                               if item["path"] == args.dependency]}
    complete = args.output.with_suffix(".complete-result.json")
    complete.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    receipt = {"artifact_sha256": digest, "dependency_path": args.dependency,
               "dependency_count": len(dependencies), "answer": answer,
               "complete_result_path": str(complete.resolve()),
               "native_text_sha256": hashlib.sha256(native.encode()).hexdigest(),
               "native_go_path": str(args.go),
               "native_go_sha256": hashlib.sha256(args.go.read_bytes()).hexdigest()}
    args.output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
