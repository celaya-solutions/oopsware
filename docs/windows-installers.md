```text
Document:    Windows Installer, MSIX and AppX inspection (format expansion F08)
Version:     v1.0.0
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-20
SHA256:      8dea7ebe681559c90e0bd979a889a50149c348b2320021b6b9161e9570006e0b
Chain:       solana-mainnet
Tx:          5spw1nVhn6MgWXo2HwWtwExRAzWA6artU7Un7Gfye2nmvCt6ng5i3V4SAUNHgo7Pz9TCNfLeRVT7SAjTXcH7ZxF1
License:     All Rights Reserved / Celaya Solutions
```

# Windows Installer, MSIX and AppX inspection

Format expansion F08 (milestone P3) reads Windows Installer packages (`.msi`) and MSIX/AppX packages and bundles from their bytes. Nothing is installed or registered: no `msiexec`, no custom action, no embedded executable or script, no COM activation and no registry change. Conditions stay as written and are never evaluated. Signatures are recorded as present; none is verified and no signer is trusted.

| Tool (MCP / CLI)                                          | Answers                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_windows_installer` / `inspect-windows-installer` | What an MSI declares: summary information, product and properties, every table with its row count, features, components, resolved directories, files with their cabinets and `MsiFileHash` rechecked, registry, services, shortcuts, environment and INI changes, custom actions decoded by type and the sequences that schedule them, launch conditions, upgrades, Binary streams and signature streams. |
| `inspect_msix_package` / `inspect-msix-package`           | What an MSIX/AppX package or bundle declares: identity, dependencies, applications and their extensions, capabilities, resources; a bundle's application and resource packages with architectures and their declared offsets checked; block maps recomputed block by block; signature parts recorded.                                                                                                     |
| `inspect_artifact` / `extract_artifact`                   | An MSI's files laid out at their resolved target directories (plus its Binary streams), and a bundle's packages, listed and materialized into owned scratch space.                                                                                                                                                                                                                                        |

```sh
oopsware inspect-windows-installer ./setup.msi --json
oopsware inspect-windows-installer ./setup.msi --cabinets ./disk1.cab --json
oopsware inspect-msix-package ./App.msixbundle --json
oopsware inspect-msix-package ./App.msixbundle --container App_1.0.0.0_x64.msix --json
oopsware extract-artifact ./setup.msi --json
```

## Windows Installer packages

An MSI is an OLE compound file whose root CLSID is the Windows Installer package class (`{000C1084-0000-0000-C000-000000000046}`; patches and transforms have their own classes and are not read as packages). The compound file is read in process: header, DIFAT, FAT and mini FAT chains, and the directory tree, every chain bounded and checked for cycles. Stream names are decoded from MSI's packed encoding.

The database is read from its string pool and its `_Tables` and `_Columns` system tables; every table's rows are decoded column by column as the database stores them. Facts are then read from the standard tables: properties, features and their component links, components (GUID, directory, attributes such as 64-bit or permanent, condition, key path), directories resolved to target paths (standard folder properties such as `ProgramFiles64Folder` are kept as names), files with long and short names, sizes, versions, attributes and the media that holds them, registry writes and removals, service installs and controls, shortcuts, environment changes, INI changes, custom actions (source kind, execution and scheduling, decoded from the type number), every sequence table in order, launch conditions, upgrades and Binary streams. Formatted values such as `[INSTALLDIR]` stay as written.

Files live in cabinets. An embedded cabinet (a stream named in the Media table with a leading `#`) is read in process: stored and MSZIP folders are decoded, CFDATA checksums are checked, and LZX and Quantum folders are listed but not decoded. An external cabinet is never searched for: pass it explicitly with `cabinets`, and it is bound to the report by its SHA-256. Each file's `MsiFileHash` MD5, when declared, is recomputed from the cabinet bytes. `\u0005DigitalSignature` and `\u0005MsiDigitalSignatureEx` are reported by size only.

Every file carries a status: `read` (digested), `cabinet-missing` (its external cabinet was not supplied), `not-in-cabinet`, `unsupported-compression` (LZX or Quantum), `damaged` (a cabinet block failed its checksum or did not decode), `over-budget` (`max_decoded_bytes` ran out) or `not-read` (stored uncompressed beside the package, or no Media row covers it). A cabinet folder is one compressed stream, so reaching a file decodes every file before it in the folder: a 10-byte file after a large one costs the large one too, and damage early in a folder spoils every file after it. A compound file whose root directory lies past the end of the file is refused as truncated; patches (`.msp`) and transforms (`.mst`) are named and refused.

## MSIX and AppX packages and bundles

A package is a ZIP with `AppxManifest.xml`; a bundle is a ZIP with `AppxMetadata/AppxBundleManifest.xml` and the packages it lists. Whether a file is MSIX or AppX comes from its suffix, as the two formats share the layout. Manifests are parsed with a hardened XML parser that refuses any DOCTYPE and caps size and markup. Applications, their extensions (protocols, startup tasks, COM servers and other categories) and capabilities (general, `uap`, restricted, device, custom) are declarations, never grants.

`AppxBlockMap.xml` is recomputed: every 64 KiB block of every member is hashed with the declared algorithm, and missing, resized, mismatched and unlisted members are reported. A bundle's declared `Offset` and `Size` for each package are checked against where the package really is in the ZIP, and every package's own manifest and block map are read. A bundle with several application architectures depends on the device; read one package in full with `container`. `AppxSignature.p7x` is reported with its size and digest, and `CodeIntegrity.cat` by presence; neither is verified.

## The public library

The hosted library extracts an MSI's files in process (embedded stored and MSZIP cabinets only) and lists a bundle's packages; it does not read MSI tables or MSIX manifests yet. SquashFS images and AppImages are listed in the report there but extracted only locally.

## Verification

- MSI fixtures are built at test time by msitools' `wixl` (an embedded MSZIP cabinet; an external cabinet `wixl` declares but does not write), and companion cabinets by `gcab`. Oracles: `msiinfo tables`, `streams`, `suminfo`, `export` for every table, `extract`, and `msiextract` for resolved file paths; `gcab -l/-x` and `7zz l -slt` for cabinets.
- No MSIX or AppX packaging tool runs on macOS, so package and bundle fixtures are hand-assembled from the published AppxManifest, AppxBlockMap and AppxBundleManifest schemas with real ZIP writing, and the signature part is a placeholder. Block maps, offsets and local header sizes are checked against the ZIP bytes; nothing claims a producer-made MSIX was read.
- Lane: `npm run verify:formats:windows-packages` compares every table's row count with `msiinfo export`, custom actions as stored, summary information with `msiinfo suminfo`, resolved file paths and bytes with `msiextract`, companion cabinet members and sizes with `gcab -l`, and checks a truncated package and a damaged cabinet block, bundle offsets and block maps, explicit selection, and that reading wrote nothing beside the inputs.

Requirements: msitools (`wixl`, `msiinfo`, `msiextract`), `gcab`, `7zz`, and a payload binary from `npm run fixtures:linux`. Without them the producer tests are skipped, not passed.
