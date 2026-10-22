#!/usr/bin/env python3
"""Check pinned Joplin static evidence from retained-facts.mjs reports.

The oracle comes from the unchanged published ElectronAppWrapper.js, not from
the production resolver. It establishes static reconstruction, not execution.
"""

import argparse
import json


def check(baseline, candidate):
    assert baseline["query"] == candidate["query"]
    archive_sha = "767df409b18effe60421fbefcca873de237c7e813eac744ecdeebbc5e825a33a"
    source_sha = "dcd2260e46dd1b4922449090e268773b052d58ba24ff977b08b978bee6cc9da1"
    for report in (baseline, candidate):
        assert report["artifact_sha256"] == archive_sha
        assert report["source_paths"] == ["ElectronAppWrapper.js", "package.json"]
        assert report["mode"] == "view"
        assert report["cli_parity"]["exact_evidence_parity"] is True
        assert report["answer"]["total"] == 1
        assert len(report["answer"]["rows"]) == 1
    before = baseline["answer"]["rows"][0]
    after = candidate["answer"]["rows"][0]
    assert before["node_id"] == after["node_id"]
    assert before["identity"] == after["identity"] == {
        "strategy": "artifact-local-key",
        "stability": "artifact-version",
        "artifact_sha256": source_sha,
        "namespace": "electron-browser-window",
        "key": "268:20-268:63",
    }
    assert before["properties"] == {
        "options_status": "dynamic",
        "web_preferences_status": "dynamic",
        "web_preferences": [],
        "preload_path": None,
    }
    properties = after["properties"]
    assert properties["options_status"] == "object-literal"
    assert properties["web_preferences_status"] == "object-literal"
    assert properties["preload_path"] is None
    assert properties["resolution_sources"] == [{
        "source": "ElectronAppWrapper.js",
        "start": {"line": 238, "column": 30},
        "end": {"line": 263, "column": 9},
    }]
    preferences = {item["name"]: item["value"] for item in properties["web_preferences"]}
    assert len(preferences) == len(properties["web_preferences"]) == 5
    expected = {
        "nodeIntegration": True,
        "contextIsolation": False,
        "spellcheck": True,
        "enableRemoteModule": True,
    }
    for name, value in expected.items():
        assert preferences[name] == {"status": "literal", "value": value, "expression": None}
        assert preferences[name]["value"] is value
    assert preferences["session"] == {
        "status": "dynamic", "value": None, "expression": "this.joplinSession_",
    }
    assert before["evidence"]["state"] == "observed"
    assert after["evidence"]["state"] == "inferred"
    assert after["evidence"]["authority"] == "static-relationship-inference"
    assert before["evidence"]["location"] == after["evidence"]["location"]
    if "analysis_fingerprints" in baseline or "analysis_fingerprints" in candidate:
        before_analysis = baseline["analysis_fingerprints"]
        after_analysis = candidate["analysis_fingerprints"]
        assert before_analysis["summary"]["explicit_web_preferences"] == 0
        assert after_analysis["summary"]["explicit_web_preferences"] == 5
        assert before_analysis["summary"] == {
            **after_analysis["summary"], "explicit_web_preferences": 0,
        }
    return {"static_oracle": "passed", "stable_window_identity": True,
            "explicit_preferences_before": 0, "explicit_preferences_after": 5,
            "runtime_configuration_verified": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("record", help="Combined baseline/candidate verification JSON")
    arguments = parser.parse_args()
    with open(arguments.record, encoding="utf-8") as record_file:
        record = json.load(record_file)
    assert record["trials"]
    receipts = [check(trial["baseline"]["profile"], trial["candidate"]["profile"])
                for trial in record["trials"]]
    assert any("analysis_fingerprints" in trial["baseline"]["profile"]
               and "analysis_fingerprints" in trial["candidate"]["profile"]
               for trial in record["trials"])
    proof = record["semantic_content_comparison"]
    assert proof["excluded_top_level_fields"] == ["application_graph_id", "graph_id"]
    assert proof["content_deep_equal"] is True
    assert proof["baseline_content_sha256"] == proof["candidate_content_sha256"]
    fingerprinted = record["trials"][-1]
    for label in ("baseline", "candidate"):
        assert proof[label + "_raw_sha256"] == fingerprinted[label]["profile"]["analysis_fingerprints"]["semantic_graph_sha256"]
    for stage in ("ordering_review_followup", "effect_query_review_followup"):
        followup = record.get(stage)
        if followup is not None:
            current = followup["profile"]
            assert current["answer"] == record["trials"][0]["candidate"]["profile"]["answer"]
            assert current["analysis_fingerprints"] == fingerprinted["candidate"]["profile"]["analysis_fingerprints"]
            assert current["cli_parity"]["exact_evidence_parity"] is True
    print(json.dumps({"trials": len(receipts), "semantic_content_unchanged": True,
                      "checks": receipts}, sort_keys=True))
