```text
Document:    Offline Supply-chain Checks
Version:     v1.0.0
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-21
SHA256:      7d167da7133e7219a2496a5e1ed78caafd3f31cccd02abfd8789768012cb3a4a
Chain:       solana-mainnet
Tx:          FqwQGn9kTnmNcf2wJZzhHfEV69kqMNQd8m5LDppW845LzM3FtsaRgE55KZocyqHLTxNjDMNnsh93Lb32nN4DnpU
License:     All Rights Reserved / Celaya Solutions
```

# What is in this software?

Three local tools build a parts list, match known vulnerabilities, and verify
signatures. CLI and MCP return the same Evidence without an open disassembler.
Nothing is downloaded, installed, or executed from the selected software.
Results describe supplied bytes and metadata; they are not a safety verdict.

| Question | MCP tool | CLI command |
| --- | --- | --- |
| Which packages and licenses are declared? | `generate_sbom` | `generate-sbom` |
| Which OSV records match these versions? | `check_vulnerabilities` | `check-vulnerabilities` |
| Does the signature verify, and who is trusted? | `verify_artifact_signature` | `verify-artifact-signature` |

## Parts and licenses

```sh
node scripts/oopsware.mjs generate-sbom ./application --json > application-sbom.json
```

`normalized_result.sbom` is CycloneDX 1.6 JSON. The rest of the report retains
source paths, metadata hashes, license findings, and coverage limits. The
vulnerability checker accepts this complete saved reply. Extract just `sbom`
when another program needs a standalone CycloneDX document.

Readers cover npm manifests and lockfile versions 2/3, Python wheel metadata,
JAR Maven properties and manifests, Go build information, Cargo lockfiles,
and Rust cargo-auditable metadata. Archives are inspected one level deep.
JAR titles alone do not establish Maven coordinates; escaped or continued
Maven property lines are outside this profile. Wheel requirements remain
unresolved. Go build information gives an inventory, not direct edges.
Missing exact versions and unresolved dependencies stay unknown.

License declarations and characteristic text matches are separate. Text
matching covers MIT, Apache-2.0, BSD-3-Clause, ISC, MPL-2.0, and Unlicense,
labelled `inferred`. Custom terms, modifications, exceptions, and license
compatibility are not determined. A filename alone proves no license.
Source hashes identify metadata, not entire packages. Directory reports
do not invent a directory digest. Coordinates are declarations, not proof
of unmodified registry releases; private or ambiguous origins stay explicit.

Defaults admit 10,000 examined entries, 64 MiB aggregate input and decoded
metadata, 5,000 components, and 4 MiB report JSON. Options `--max-files`,
`--max-input-bytes`, `--max-components`, and `--max-output-bytes` have bounded
upper limits. Individual metadata documents are limited to 8 MiB. Exceeding a
limit refuses the operation. Directory links are not followed; selection uses
metadata/license/archive/native names, executable bits, or extensionless files.
This does not discover every statically linked or renamed component.

## Offline vulnerabilities

```sh
node scripts/oopsware.mjs check-vulnerabilities application-sbom.json \
  --database ./osv-snapshot.json --json
```

Supply one OSV record, an array of records, or a dated envelope:

```json
{
  "schema": "oopsware-osv-snapshot-v1",
  "generated_at": "2026-10-21T00:00:00Z",
  "records": []
}
```

A directory of OSV JSON records is accepted too. Its optional root
`manifest.json` has the same `schema` and `generated_at`, without `records`.
The report identifies the snapshot by its bytes. A directory digest covers
sorted relative paths, file hashes, and sizes. The date is a declaration,
not proof of freshness; advisory modification dates never stand in for it.
A stated 30-day reporting threshold marks old snapshots. Undated and
future-dated snapshots are explicit.

Exact affected-version lists cover npm, PyPI, Maven, Go, and crates.io.
Semantic ranges cover npm, Go, and crates.io where ordering can be established.
PyPI/Maven ecosystem-specific ranges, Git ancestry, missing versions,
conflicting identities, and unknown range forms stay unassessed. Withdrawn
records are counted separately. Findings and unresolved assessments can coexist.

No matches means only no matches in the supplied snapshot. Database coverage
is unknown, and vulnerable-code reachability is not assessed. Nothing queries
or updates OSV. Limits are 16 MiB SBOM, 128 MiB database JSON, 20,000 directory
entries, 100,000 records, 10,000 components, 5,000 findings, two million
comparisons, and 8 MiB output. Prepare relevant local subsets separately when
a snapshot exceeds these limits; do not describe a subset as complete.

## Signatures and trust

```sh
node scripts/oopsware.mjs verify-artifact-signature ./application.jar --kind jar --json
node scripts/oopsware.mjs verify-artifact-signature ./application.exe \
  --kind authenticode --trusted-certificate ./publisher.pem --json
node scripts/oopsware.mjs verify-artifact-signature ./module.whl \
  --kind wheel --public-key ./publisher-key.pem --json
```

Choose `jar`, `authenticode`, `apple`, or `wheel` explicitly. Integrity,
signer identity, and trust have separate results. `--expected-signer-sha256`
checks certificate DER SHA-256, or public-key SPKI DER SHA-256 for wheel JWS.
Supplied trust material selects a trust basis; Oopsware never chooses a
publisher on your behalf. Inapplicable options are rejected.

- JAR: installed jarsigner checks signed content. Unsigned content prevents a
  whole-archive claim. Caller certificates use a separate temporary trust store.
- Authenticode: installed osslsigncode and OpenSSL check signed digests,
  signatures, and optional caller trust. Timestamp checks are disabled;
  nested and catalog signatures are outside the initial profile.
- Apple: installed codesign checks one regular Mach-O file, including its
  architectures. Bundles and enclosing resources are outside this profile.
  Ad-hoc integrity does not establish a developer identity.
- Wheel: RECORD member hashes and coverage are checked separately from JWS
  or detached CMS signatures. JWS requires an explicit public key; CMS uses
  OpenSSL. RECORD hashes alone are never a verified signature.

Revocation and Apple notarization stay `not_checked` offline. Signature
formats intentionally omit some container bytes. Helpers are found at fixed
install paths; missing helpers are reported and never installed. Their paths
and observed hashes are retained, but these are not digest-pinned decompiler
releases. Checks use private copies, bounded helper output, timeout, and owned
process cleanup. No external trust service is contacted. A valid signature
does not establish benign behavior, a complete inventory, or license rights.

## Verification

Use the pinned Node version and installed tools:

```sh
npm run test:local -- src/supplyChain/sbom.test.ts src/supplyChain/vulnerabilities.test.ts src/supplyChain/signatures.test.ts src/supplyChain/signaturesLifecycle.test.ts src/application/supplyChain/SupplyChainService.test.ts src/artifacts/zipMemberView.test.ts
npm run test:focused -- tests/acceptance/applications/supplyChain.test.ts
npm run check:fast
```

Tests cover producer-built metadata, range boundaries, signed/tampered and
unsigned inputs, cancellation, and retained cleanup ownership. Acceptance
passes a saved SBOM through the offline checker via the compiled CLI and real
stdio MCP, compares their Evidence, and validates exported CycloneDX JSON.

Unmodified schemas under `tests/fixtures/cyclonedx/` come from the
[CycloneDX specification's 1.6 tag](https://github.com/CycloneDX/specification/tree/1.6/schema)
with its Apache-2.0 license. The JSF schema retains Anders Rundgren/OpenKeyStore
credit. They are test fixtures, not runtime dependencies. No check deploys
to Railway or uses GitHub Actions.
