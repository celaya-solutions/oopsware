```text
Document:    Linux package, AppImage and SquashFS inspection (format expansion F05)
Version:     v1.0.0
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-20
SHA256:      7fbf4833e7a4f7e5e90c4385965d76da61794f77530d8bf92bcbc46e72c02bf7
Chain:       solana-mainnet
Tx:          4VvEXngWQMLZDRMVxGdiaSan1GpqzTEZfukDqw5FaDwDyx4JsdBjW8VDbwNWm8SC6UGiQ15Ka6i8buH5eNEGe41C
License:     All Rights Reserved / Celaya Solutions
```

# Linux package, AppImage and SquashFS inspection

Format expansion F05 (milestone P3) reads Debian packages, RPM packages, Type 2 AppImages and SquashFS images from their bytes. Nothing is installed or unpacked onto the system, no maintainer script, scriptlet or trigger runs, no AppImage is executed, mounted or asked to `--appimage-extract` itself, and no repository is contacted. Declared signatures are recorded as present; none is verified and no key is trusted.

| Tool (MCP / CLI)                                  | Answers                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_linux_package` / `inspect-linux-package` | What a `.deb`, `.rpm`, AppImage or SquashFS image is and declares: identity, every dependency declaration, maintainer scripts or scriptlets as text, triggers, conffiles, Debian control fields, RPM header and payload digests, signature material, AppImage runtime, desktop entry and AppRun, and a page of files with modes, owners, link targets, flags and digests rechecked. |
| `inspect_artifact` / `extract_artifact`           | The package contents in the artifact graph: a `.deb`'s `data.tar`, an `.rpm`'s cpio payload, and an AppImage's or SquashFS image's filesystem, listed and materialized into owned scratch space.                                                                                                                                                                                    |

```sh
oopsware inspect-linux-package ./tool_1.0-1_amd64.deb --json
oopsware inspect-linux-package ./tool-1.0-1.x86_64.rpm --json
oopsware inspect-linux-package ./Tool-x86_64.AppImage --start 1000 --limit 1000 --json
oopsware extract-artifact ./tool_1.0-1_amd64.deb --json
```

MCP input for `inspect_linux_package`: `path` (absolute); `start`/`limit` page the files; `max_file_bytes` and `max_decoded_bytes` bound the read.

## How a file is read

The bytes decide the kind: an `ar` archive whose first member is `debian-binary` is a Debian package, the lead magic `ED AB EE DB` an RPM, an ELF file with `AI` and a type byte in its identification padding an AppImage, and `hsqs` a SquashFS image. A name that suggests another kind is reported as a conflict. An AppImage is recorded in the artifact graph as a container of its filesystem, not as an executable to open in a disassembler.

## Debian packages

The `ar` members are validated header by header. `debian-binary` gives the format version; `control.tar` and `data.tar` may be uncompressed or gzip-, zstd- or xz-compressed (zstd and gzip in process, xz by the installed `xz` found at fixed paths, with its digest and version recorded); bzip2 and lzma members are reported, not decoded. `_gpg*` members are listed as signatures, never checked.

Control fields keep their order and their text. Relation fields (`Depends`, `Pre-Depends`, `Recommends`, `Suggests`, `Enhances`, `Breaks`, `Conflicts`, `Provides`, `Replaces`, `Built-Using`) are parsed by Debian's syntax into groups of alternatives with operator, version, architecture qualifier, architecture restrictions and build profiles. `preinst`, `postinst`, `prerm`, `postrm` and `config` are returned as text with the interpreter from their `#!` line and a SHA-256; they are never run. `conffiles` mark files; every `md5sums` entry is recomputed over the data member, and missing, mismatched and unlisted files are counted.

## RPM packages

The lead, the signature header and the main header are read entry by entry, every offset and count checked against the header's data store. Identity, descriptions, license, build facts and every dependency kind (requires, provides, conflicts, obsoletes, recommends, suggests, supplements, enhances, order-with-requires) come with their RPM sense flags (`pre`, `post`, `interp`, `rpmlib` ...); rich (boolean) dependencies are kept as written. Scriptlets and triggers are returned with their interpreters and bodies, never run.

Both RPM 4 packages (newc cpio payload) and RPM 6 packages (the default of rpm 6.x: a stripped `07070X` cpio whose names, modes and sizes come from the header, and SHA-256 and SHA3-256 header digests) are read. Files come from the header with mode, owner and group names, size, time, link target and flags (`config`, `noreplace`, `doc`, `license`, `ghost` ...). The cpio payload (gzip, zstd, xz or lzma; bzip2 is reported, not decoded) is decoded to recompute each file's digest with the header's algorithm; a hard link's bytes travel with one link and every link shares that digest. The SHA-1 and SHA-256 header digests and the payload digest are recomputed. RSA, DSA and OpenPGP signature packets are listed by size, never verified.

## AppImages and SquashFS

A Type 2 AppImage is the AppImage runtime (an ELF file) followed by a SquashFS image. The image starts where the runtime's section header table ends (`e_shoff + e_shentsize × e_shnum`), which is how the runtime finds it. The runtime's machine, its `.upd_info` update information, and the presence of `.sha256_sig` and `.sig_key` signature sections are reported; nothing in them is checked. A Type 1 AppImage (ISO 9660) is identified only.

SquashFS 4.0 images are read in process: superblock, inode and directory tables, data blocks and fragments, with gzip, zstd and lz4 compression; xz, lzma and lzo images are identified and refused with the compressor named. Every table offset is checked against the image, metadata expansion and directory depth are bounded, and names that are not UTF-8, are empty, are `.` or `..`, or contain `/` are reported and not listed. An AppImage's root desktop entry is parsed by the freedesktop Desktop Entry rules, and `AppRun` is described (its interpreter or ELF machine, or its link target) without running it.

## Extraction

`extract_artifact` writes regular files into owned scratch space with the existing containment and digest checks. Symbolic links are recorded, not created; device nodes, FIFOs and sockets are reported and never created; owners and setuid/setgid bits are stated in the entry's limitations and never applied. Hard links: a tar hard link is recorded as a link entry, a cpio link that stores no bytes is reported (its bytes travel with another link, as rpm writes them), and a SquashFS hard link is materialized as its own copy. A native file inside a package (for example an ELF library) is handed to the native tools from its extracted copy.

## Verification

Fixtures are built at test time by real producers (`tests/fixtures/linuxProducers.ts`): `dpkg-deb` (uncompressed, gzip, zstd and xz members), `rpmbuild` (zstd, xz and gzip payloads, scriptlets in shell, bash and Lua, triggers, rich dependencies, `%config`, `%doc`, `%ghost`, setuid and Unicode paths), `mksquashfs` (gzip, zstd, lz4 and xz images), and the pinned AppImage type2-runtime release `20251108` (fetched and hash-checked by `npm run fixtures:linux`, used only as bytes). Nothing binary is committed; nothing is installed.

- Debian oracles: `ar`, `dpkg-deb -f/-I/-c` and the control and data archives `dpkg-deb` extracts.
- RPM oracles: `rpm -qp` with every query tag, `--requires` and the other dependency queries, `--scripts`, `--triggers` and `--dump`.
- SquashFS oracles: `unsquashfs -lls`, `-pf` and `-cat`, and `-o` for the image inside an AppImage.
- Lane: `npm run verify:formats:linux-packages` builds the fixtures, runs the CLI and the artifact tools on each kind, and checks the extracted ELF.

Requirements for the producer checks: `dpkg-deb`, `rpmbuild`, `rpm`, `mksquashfs` and `unsquashfs` (Homebrew `dpkg`, `rpm` and `squashfs`), and the pinned runtimes (`REA_TEST_APPIMAGE_RUNTIMES`, or `_reference/linux-packages` after `npm run fixtures:linux`). Without them the producer tests are skipped, not passed.
