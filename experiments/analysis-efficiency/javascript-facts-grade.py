#!/usr/bin/env python3
"""Audit compact Joplin retained-fact trial records; print checks, not a success rate.

The oracle is specific to the pinned shipped artifact and selected public workflow.
Coverage checks recognize a partial declaration, not the correctness of arbitrary
free-form prose. Read the preserved answers and qualifications alongside these checks.
"""
import json
import sys

SOURCE_PATHS = [
    'ElectronAppWrapper.js', 'ElectronAppWrapper.js.map', 'index.html',
    'package.json', 'node_modules/keytar/build/Release/keytar.node',
]
NATIVE_SHA256 = '0700016bcd761cbe02d275f2046c7cc42f39f730a50d66e3d3307aa9d413373a'
NATIVE_NODE = 'jag_node_98ccdef0e85d67cba9cc843193c5ba877f0a73ba3fa7d3581f6db0396a707b2d'
NATIVE_OBSERVATION = 'jag_observation_d7fbf97718fa986435ef951cf11b73f63610f59facd1b40c22fc9f06876d54bc'
PHASES = {
    'ElectronAppWrapper.js.map': (
        'parse-local-source-map',
        'jag_observation_4b04b2982325de96322efd493507386b986aca57309e959870831dbd6dffd4fd',
    ),
    'index.html': (
        'parse-html-script-references',
        'jag_observation_f432dffb800852a9d28d2f85c17ae6b5d83b7b2ae5780021169506a8d08f0d35',
    ),
    'package.json': (
        'parse-package-json',
        'jag_observation_5dae4759fcf36b25470467347515c95207d69d7ececfc17a1d90ecfbbea4dc79',
    ),
}


def grade(record):
    result = record['result']
    if record['version'] == 'invalid-host':
        return {'name': record['name'], 'excluded': 'CLI tool-dispatch harness failure'}
    answer = result['answer']
    native = answer['native']
    analysis_calls = [op for op in result['operations']
                      if op.get('tool') == 'analyze_javascript_application']
    task = result['task']
    expected_package = ({'name': '@joplin/app-desktop', 'version': '3.7.21'}
                        if task == 'direct' else {'name': None, 'version': None})
    expected_gaps = [dict(path=path, operation=operation,
                          analysis_status='not-started', authority='artifact-bytes',
                          state='unavailable', confidence='unknown',
                          observation_id=observation)
                     for path, (operation, observation) in PHASES.items()]
    gaps = answer['processing_gaps']
    checks = {
        'parent_matches_actual_tool_receipt': answer['parent_evidence_id'] == result['observed_parent_evidence_id'],
        'one_preparation_without_retry': len(analysis_calls) == 1,
        'caller_source_paths_preserved': all(op['arguments'].get('source_paths') == SOURCE_PATHS for op in analysis_calls),
        'summary_preparation': all(op['arguments'].get('detail') == 'summary' for op in analysis_calls),
        'requested_timeout_preserved': all(op['arguments'].get('analysis_timeout_ms') == (1 if task == 'partial' else None) for op in analysis_calls),
        'native_path_node_and_digest': native['path'] == SOURCE_PATHS[-1] and native['node_id'] == NATIVE_NODE and native['sha256'] == NATIVE_SHA256,
        'byte_observation_cited': NATIVE_OBSERVATION in native['observation_ids'],
        'static_bytes_not_promoted_to_execution': native['observed_byte_identity'] is True and native['runtime_execution'] == 'unknown',
        'package_fields': answer['package'] == expected_package,
        'exact_requested_processing_phase_facts': (sorted(gaps, key=lambda g: g['path']) == sorted(expected_gaps, key=lambda g: g['path']) if task == 'partial' else gaps == []),
        'declares_partial_application_and_semantic_coverage': all('partial' in answer['source_coverage'][key].lower() for key in ['application', 'semantic']),
    }
    qualifications = []
    if set(native['observation_ids']) - {NATIVE_OBSERVATION}:
        qualifications.append('Additional native citations need node-ownership review; the observed ASAR-entry citation belongs to a different node, although traceable to the same parent.')
    if not checks['exact_requested_processing_phase_facts']:
        qualifications.append('Review original answer: missing original-source content differs from an unavailable processing phase; no unqualified phase-answer success.')
    return {'name': record['name'], 'checks': checks, 'qualifications': qualifications}


def main():
    with open(sys.argv[1], encoding='utf-8') as stream:
        records = json.load(stream)
    assert records['artifact']['asar_sha256'] == '767df409b18effe60421fbefcca873de237c7e813eac744ecdeebbc5e825a33a'
    print(json.dumps([grade(record) for record in records['actual_agent_trials']], indent=2))


if __name__ == '__main__':
    main()
