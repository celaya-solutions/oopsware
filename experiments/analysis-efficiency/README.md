```text
Document:    Oopsware Analysis Efficiency Harness
Version:     v1.0.0
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      0f7da9f109cf844256bb7df64cc16430b715ab3e814298b286c995adab0655b6
Chain:       solana-mainnet
Tx:          2fwPknUYEonx1hq1Wh8SW9AzW81KZnpGv5v9YXgyVPcw3ENdcWnC78E7n4XetmGKV4LDGRcbJQz97cBiNq9aR8SJ
License:     All Rights Reserved / Celaya Solutions
```

# Analysis efficiency harness

These scripts compare completed CLI/MCP analysis tasks. They are development
and test tools; they are not needed to run Oopsware. Several production-boundary
tests import their comparators and oracles.

`corpus.json` records public artifact sources and expected digests.
`provider-environment.json` defines the provider settings the runners accept.
Supply local artifact paths and provider configuration explicitly. Keep raw
Evidence, model transcripts, credentials, and measurement output outside the
repository; `results/` is ignored.

## Run a measurement

Use the pinned Node/npm versions and locked dependencies. Build the revisions
being compared into separate runtime directories with matching dependencies.
Record the actual revision for each runtime; do not compare an old revision
label against a newly built tree.

```sh
python3 experiments/analysis-efficiency/resource-run.py -- \
  node experiments/analysis-efficiency/measure.mjs \
  --runtime-root /absolute/frozen-runtime \
  --revision REVISION \
  --artifact obsidian.asar --path /absolute/obsidian.asar \
  --providers /absolute/selected-providers.json \
  --output /absolute/new-measurement-directory

node experiments/analysis-efficiency/compare.mjs \
  --left /absolute/baseline-run --right /absolute/candidate-run \
  --output /absolute/new-comparison.json
```

The resource wrapper requires Linux cgroup v2 and a working user systemd manager.
It limits and cleans up its own process scope. Inspect its capacity options
before running large providers. Other runners have their own platform and
provider requirements; they do not install those tools.

Compare equivalent analyst questions and complete Evidence, including discovery,
retries, and follow-up calls. Report measured tokens, elapsed time, aggregate CPU
time, and process-family memory separately. Serialization sizes are not token
counts; sampled memory peaks can miss short spikes. Keep cold and warm runs
separate, retain failed attempts, and state unmeasured costs and provider limits.

Archived measurements are not distributed here. Running a fixture test does not
establish real-provider behavior or a performance improvement.
