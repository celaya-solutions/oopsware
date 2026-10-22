# Model file declarations

Use `inspect_model_artifact` (CLI: `inspect-model-artifact`) to inspect a local
GGUF v2/v3 or safetensors file. Detection uses content, including GGUF byte
order, rather than its extension. REA does not load a model, interpret weights,
run inference, import Python, open external-data references or use the network.

```bash
rea inspect-model-artifact /absolute/path/model.gguf --json
rea inspect-model-artifact /absolute/path/model.safetensors --hash full --json
```

The CLI defaults to complete Evidence. For compact delivery with portable access
to every retained observation:

```bash
rea inspect-model-artifact /absolute/path/model.gguf \
  --detail summary --evidence_output /absolute/path/model-evidence.json --json
```

## Identity and reads

The default `hash: "header"` reads only the metadata and tensor directory. The
result records the exact selected path, file size, header length, header SHA-256,
bytes read and read scope. GGUF alignment padding is outside this prefix.
`artifact.sha256` and the Evidence subject are null: a header digest is not a
commitment to the weights. Different files can have identical headers and sizes.

`hash: "full"` additionally streams the remaining file bytes through SHA-256.
It returns a full-file digest and Evidence subject, while retaining the same
header digest. It uses bounded buffers and does not interpret tensor data, but
it does read the whole file. Cost therefore grows with file size. Both modes
check descriptor and selected-path identity and metadata before completion;
this detects observed replacement or modification, not adversarial modification
that defeats filesystem metadata checks.

## Facts and selected queries

GGUF reports version, byte order, alignment, typed metadata, and each tensor's
name, original type ID, dimensions, relative data offset, file offset and derived
byte length. Alignment accepts every positive UINT32 multiple of eight, including
non-powers of two. Metadata keys use ASCII lower-snake-case hierarchy components;
standard numeric components such as `general.base_model.0.name` are preserved.
Scalar metadata is complete. Arrays have declared element types,
counts and at most eight preview elements per array, with an explicit
`preview_complete` flag. This includes tokenizer vocabularies: omitted values
are not silently represented as a complete array. Strings are UTF-8; 64-bit
integer metadata and all shape dimensions use decimal strings without rounding.
Nonfinite floating metadata uses `NaN`, `+Infinity` or `-Infinity` with its
declared float type; negative zero is `"-0"`. Unknown tensor types retain their numeric IDs and null byte
lengths; affected totals and storage validation remain unknown.

Safetensors reports the header extent, exact string `__metadata__` values, dtype,
shape and declared data ranges. JSON duplicate keys, invalid UTF-8, out-of-file
ranges, overlaps, gaps, trailing unindexed data and known dtype/shape byte-length
contradictions are rejected with a typed `file_format_rejected` constraint (public code `target_unavailable`, category `unsupported_target`). Empty
tensors and scalar shapes are supported; packed sub-byte types require whole
byte storage. Unknown dtypes retain declared ranges and an explicit limitation
that shape-to-storage validation is unavailable. Each tensor records
`storage_validation: "consistent" | "unknown"`; `coverage.storage_sizes` remains
partial when that consistency cannot be checked. Tensor filters accept these
`storage_validation` states independently of dtype or name.

Parameter counts and per-type totals are **derived from declarations**, not
measurements of effective parameters or inference behavior. Shared or repeated
weights are not deduplicated. GGUF dimensions retain their original fastest-first
order; safetensors shapes retain JSON order. Safetensors tensor rows use name
order; GGUF rows use directory order. An index identifies a declaration within
its collection and header digest, not tensor contents or a cross-version match.
GGUF supports zero extents and scalar shapes, with at most four dimensions;
known quantized types still require complete blocks in the first dimension.

MCP defaults to a compact summary with counts, selected short headline metadata,
chat-template presence and derived totals. The full type histogram and all rows
remain in complete Evidence. Headline metadata uses short keys/types and scalar
values; long or compound values remain available through explicit metadata
queries. Use the returned `parent_evidence_id`:

```json
{
  "source": {
    "kind": "retained-evidence",
    "evidence_id": "<parent_evidence_id>"
  },
  "view": {
    "kind": "model-artifact",
    "collection": "tensors",
    "names": ["token_embd.weight", "output.weight"],
    "fields": ["name", "type", "shape", "file_offset", "byte_length"],
    "offset": 0,
    "limit": 32
  }
}
```

To answer a known question in the initial inspection, pass the same selection
without `kind` as `inspect_model_artifact`'s optional `view`, for example
`{"path":"/absolute/path/model.gguf","view":{"collection":"tensors","names":["token_embd.weight"],"fields":["type","shape","file_offset"]}}`.
This returns one selected page with compact model context and retains the full
source Evidence, avoiding another tool call. `view` requires summary delivery;
complete detail and a selection are rejected as conflicting choices.
CLI uses `--view '{"collection":"tensors","names":["token_embd.weight"]}'`
with `--detail summary --evidence_output FILE`.

Call `inspect_analysis_view` with the historical query object above for further pages. `collection: "metadata"` accepts
exact `keys`, indices, fields and paging; use it for `tokenizer.chat_template`
or tokenizer array previews. `collection: "types"` pages derived storage and
parameter totals and accepts exact `types`. Tensor pages also accept `types`.
Filters intersect; omitted filters mean all recorded rows and empty arrays mean
none. Every row retains its source-scoped index. Names, keys and type labels
follow field selection; `fields: []` returns only indices. Omitted fields return
all recorded columns. Compact warnings use the shared bounded view budget and
link to complete parent Evidence when messages are omitted. Page offsets count filtered
matches, while row indices retain their original scope. Each page carries source
identity, header coverage, array omissions, unknowns and parent Evidence links.

Pages read historical retained facts without reopening the model. Complete
Evidence can also be supplied inline or as a single authenticated Evidence JSON
record through `source: {"kind": "evidence-file", "path": "/absolute/path/model-record.json"}`.
CLI Evidence bundles contain a `records` array; import the bundle with
`import_evidence_bundle` before using retained queries, or save one complete
record as a standalone Evidence file. A bundle is not a single Evidence record.
The session owns validated indexes until that Evidence is released; there is no
live-file result cache or automatic freshness claim.
Imported reports must retain positional indices and unique names, keys and
type identities; malformed reports return a typed input error before indexing.

## Bounds and unsupported inputs

The reader admits one active inspection per provider. It enforces a 100,000,000
byte header ceiling (safetensors counts its declared JSON bytes separately from
the fixed eight-byte length prefix; GGUF counts the complete header) and a separate 32 MiB
retained representation budget before retaining rows or expanding strings.
Numeric products use exact integer arithmetic. GGUF follows its four-dimensional
tensor layout and limits metadata array nesting to 32 frames. Resource refusals
are typed, rather than returned as complete empty inventories. Cancellation
joins descriptor finalization; failed cleanup remains owned for retry.

PyTorch pickle and ZIP model deserialization are unsupported; convert using a
trusted external workflow and supply GGUF or safetensors. ONNX, TFLite, Core ML,
model execution and conversion are outside this operation.

Format references: [GGUF specification](https://github.com/ggml-org/ggml/blob/da8e2a54b919557b816b1c2beb432ccb766f7ce0/docs/gguf.md),
[ggml tensor layouts](https://github.com/ggml-org/ggml/blob/da8e2a54b919557b816b1c2beb432ccb766f7ce0/src/ggml-common.h),
[safetensors format](https://github.com/huggingface/safetensors/tree/e246a2560645b7525f5775669ed816eb57c5bcc8#format).
