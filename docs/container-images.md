```text
Document:    OCI and Docker image inspection (format expansion F09)
Version:     v1.0.0
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-21
SHA256:      12c280e8ee1fe51a870b4824b86586066c3121a36b7a0b3c91d948dc9a8d99fa
Chain:       solana-mainnet
Tx:          JL2cY79HicZ6T9GDpy9MKDUzzYQLBKRDTyqXNpetqapnxQjXxWvdR8chFxh9TXyFr9MsMiZGa1KgrYWHUS5xpKW
License:     All Rights Reserved / Celaya Solutions
```

# OCI and Docker image inspection

Format expansion F09 reads container images from their bytes: an **OCI image layout directory**, an **OCI image archive** and a **Docker save archive**. Nothing is pulled from a registry, no Docker daemon is started, no container runs, no hook is applied, no layer is mounted and no entrypoint is executed. Foreign layers are named with their URLs and never fetched.

| Tool (MCP / CLI)                                      | Answers                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_container_image` / `inspect-container-image` | Which images the index or `manifest.json` lists (digest or image id, platform, ref names, attestation manifests marked), the selected image's configuration, each layer with its digests checked, and a page of the composed filesystem or of one layer's own entries. |
| `inspect_artifact` / `extract_artifact`               | The composed filesystem of a single-image archive, listed and materialized into owned scratch space. A multi-platform image, or one with a missing, foreign or mismatching layer, is not extracted.                                                                    |
| `identify_artifact`                                   | "What is this?" names the image, its platform, layer count and entrypoint.                                                                                                                                                                                             |

```sh
oopsware inspect-container-image ./app.tar --json
oopsware inspect-container-image ./app-layout --platform linux/arm64 --json
oopsware inspect-container-image ./app.tar --layer 2 --json
oopsware extract-artifact ./app.tar --json
```

## What counts as an image

A tar is an image by the names it holds, not by its first bytes:

- a **Docker save archive** has a top-level `manifest.json` (newer Docker also writes an OCI layout beside it; the report says so with `has_oci_index`);
- an **OCI image archive** has a top-level `oci-layout` and `index.json`;
- an **OCI image layout directory** has an `oci-layout` file and an `index.json`.

A plain tar, such as a `docker export` root filesystem, has no image configuration or history. It is refused by `inspect_container_image` with that reason and stays an ordinary `tar` in the artifact graph. Gzip-compressed archives are refused with a hint to decompress first.

## What is checked

- **Manifests, configuration and layer blobs** are recomputed against their descriptor digest (sha256 and sha512) and size. The state is `verified`, `digest_mismatch`, `size_mismatch`, `missing`, `foreign` or `unverifiable` (no digest to check, or an algorithm this reader does not compute).
- **Compressed digest and diff id are different things.** The blob digest covers the layer as stored (gzip, zstd or none). The configuration's `rootfs.diff_ids` cover the uncompressed tar; the reader decodes each layer and compares. A legacy Docker save layer declares no blob digest, so only its diff id can vouch for it.
- **A layer that fails a check is read but not applied** to the composed view, and the report says which check failed. Inventory and inspect coverage become `partial`. A manifest that does not match its digest applies no layer at all (its layer list is not trusted); a configuration that does not match its digest leaves the layers applied but makes the diff ids untrusted and the result `partial`. A layer that nothing vouches for (no blob digest and no diff id, as when a Docker save configuration lists fewer diff ids than layers) is not applied.
- **Multi-platform indexes** need `platform` (`linux/arm64`, `linux/arm64/v8`) or `manifest` (an id from `manifests[].id`). Without one the images are still listed, `selection.state` is `ambiguous` and no layer is read. Attestation manifests are marked and never selected by platform. Nested indexes are followed four levels deep.

## The composed filesystem

Layers are applied in order to a virtual view; no file is written. For each layer, opaque-directory markers and whiteouts hide **lower** layers only; then the layer's own entries land, replacing what they name. A file that replaces a directory drops what was below it; a directory over a directory merges. A layer that adds a child below a name it never listed gets an `implicit` parent directory. Whiteout names (`.wh.<name>`, `.wh..wh..opq`) never appear in the composed view; reserved AUFS names (`.wh..wh.*`) are ignored with a diagnostic.

Each entry names the layer it comes from. `layer: N` lists layer N's own entries instead, whiteouts and opaque markers included (`hides` says what each one hides); deleted content is visible only there. Each layer record counts the lower-layer entries it hid or replaced (`removed_from_lower`).

Names are normalized once (`./etc//passwd` and `/etc/passwd` are `etc/passwd`). An entry is skipped, with a diagnostic and the layer marked `partial`, when its name climbs above the root, is not UTF-8, is over 4,096 bytes, is more than 512 directories deep, has a link target over 4,096 bytes, or is a pax sparse member (whose stored bytes are not the file's content). A skipped entry makes the listing incomplete, so `extract_artifact` refuses. A tar member whose data is cut off is not kept. Modes, setuid/setgid/sticky bits, owners and times are stated and never applied; devices, FIFOs and sockets are not created. Hard links are recorded as links to a path and are resolved against the view as it stood at their own layer, so a later replacement or deletion of the target does not change them (`link_status` and `size` are fixed then); a symbolic link is checked lexically (`resolved`, `dangling`, `escapes_root`) and never followed. `extract_artifact` writes a hard link as its own copy.

## Configuration is a declaration

User, working directory, environment, entrypoint, command, exposed ports, volumes, labels, stop signal and history come from the image configuration. They say what the image author declared, not what a container would do. History is mapped to layers in order, skipping `empty_layer` steps.

## Limits

- An archive is read into memory (`max_file_bytes`, default 256 MiB, up to 1 GiB; a layout's blobs are read one at a time against the same bound). Layers are decoded in process (tar, gzip, zstd) against `max_decoded_bytes` (default 512 MiB, up to 2 GiB); a layer over the budget fails the call with a typed resource error naming the limit.
- The composed view holds at most 1,000,000 entries, and a layer or the whole view at most 256 MiB of entry names and link targets. A manifest is read for at most 1,024 layers and an index for 1,024 images; a report lists at most 1,000 diagnostics (a layer lists 100 and counts the rest). A layout blob is a regular file whose real path stays under the layout root; a link, or a linked parent directory, that leads outside it is not a blob.
- `open()` on a graph member re-reads its layer and refuses it if the layer no longer matches the bytes the listing vouched for. Opens are served one at a time by one forward cursor: finish or close one stream before reading the next.
- The image-or-tar decision examines the first 8,192 tar members; a tar whose markers come later stays a tar.
- The artifact graph (`inspect_artifact`, `extract_artifact`) reads a single-image archive or layout. A multi-platform image needs `inspect_container_image` to choose; the graph tools cannot pass a platform. An image tar nested inside another archive is listed as a tar, not as an image. Any missing, foreign, damaged or mismatching layer is an omission, so extraction refuses.
- Hard-link inode identity across layers and symbolic links in parent paths are not resolved.
- bzip2 layers and other layer compressions are listed but not read. Docker "foreign" layers are never fetched.
- The hosted service does not open images; uploads keep the byte preview.
- Fixtures are hand-assembled from the image specifications (no image builder is installed on this host) and checked against the host `tar` and `shasum`; no producer-made image (Docker, podman, buildah, skopeo) has been read yet.

## Checks

- `src/containerImage/containerImage.test.ts`: the provider on an OCI layout directory, an OCI archive, a legacy Docker save archive, a multi-platform index with an attestation, tampered and missing blobs, a foreign layer, a wrong diff id, a damaged tar, unsafe names, the decoded budget, and the host `tar` and `shasum` as oracle.
- `src/containerImage/layerView.test.ts`: path normalization, whiteout parsing and the composed view.
- `tests/boundary/filesystem/containerImageGraph.test.ts`: inventory and extraction of the three forms, plain tar kept a tar, refusal on an incomplete listing, byte-exact extracted files.
- `tests/acceptance/applications/containerImage.test.ts`: the compiled CLI and the real stdio MCP return identical Evidence.
