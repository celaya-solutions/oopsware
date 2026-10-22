```text
Document:    Python source, bytecode, wheel and zip application inspection (format expansion F03)
Version:     v1.1.0
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-21
SHA256:      27a5f47fb1c29083cfbd707aab1fb4daaf23c7f91377b0343fa680a2956e54fb
Chain:       solana-mainnet
Tx:          3iPsFuZuoQPzpU9wQTz73phrAsB4NWrrtPXuDrbg8SuRoJN6RYKhLZWkZq2pL52CWFjCNFj9YvjqDAM2Srx6R7cF
License:     All Rights Reserved / Celaya Solutions
```

# Python source, bytecode, wheel and zip application inspection

Four tools cover format expansion F03 (milestone P2, plus the pycdc decompiler from roadmap item 5). They read one explicitly selected local file's bytes. Nothing is imported, installed, compiled or run: no `pip install`, no `__main__.py`, no entry point, no import hook.

| Tool (MCP / CLI)                                      | Answers                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inspect_python_artifact` / `inspect-python-artifact` | What a `.py`, `.pyc`, wheel, zip application or ZIP is: `.pyc` header, wheel name tags, METADATA, WHEEL, entry points, RECORD digests recomputed, license files, native extensions, `.data` schemes, zip application shebang and `__main__.py`, a page of modules. |
| `inspect_python_module` / `inspect-python-module`     | One module. Source: encoding, syntax error, docstring, imports, definitions, decorators, calls, dynamic imports and reflection, `__all__`, `__main__` blocks. Bytecode: header, every code object in pre-order, IMPORT_NAME sites.                                 |
| `inspect_python_code` / `inspect-python-code`         | One code object of a `.pyc`: a page of instructions as that release's `dis` shows them, with jump targets, cache units, lines and column spans; the exception table, constants, names and variables.                                                               |
| `decompile_python_code` / `decompile-python-code`     | Inferred source for one `.pyc` (Python 2.7, 3.5-3.13) from an owner-installed, digest-pinned pycdc, with three checks: pycdc's warnings, whether a same-release CPython compiles it, and whether its code objects match the original's by name.                    |

```sh
oopsware inspect-python-artifact ./example-1.0-py3-none-any.whl --json
oopsware inspect-python-artifact ./app.pyz --json
oopsware inspect-python-module ./tool.py --json
oopsware inspect-python-module ./tool.py --python 3.12 --max-listed 500 --json
oopsware inspect-python-module ./example-1.0-py3-none-any.whl --entry example/cli.py --json
oopsware inspect-python-module ./module.cpython-313.pyc --json
oopsware inspect-python-code ./module.cpython-313.pyc --code Child.fetch --json
oopsware inspect-python-code ./app.pyz --entry pkg/__pycache__/mod.cpython-313.pyc --code-index 2 --json
oopsware decompile-python-code ./module.cpython-312.pyc --json
oopsware decompile-python-code ./app.pyz --entry pkg/__pycache__/mod.cpython-38.pyc --no-check --json
```

MCP input: `path` (absolute); `entry` selects a `.py` or `.pyc` member of a wheel, zip application or ZIP; `python` picks the grammar for source; `code` (a unique qualified name) or `code_index` (the pre-order index `inspect_python_module` lists, 0 for the module) picks a code object; `start`/`limit` page modules and instructions; `max_file_bytes` and `max_decoded_bytes` bound the read.

## How a file is read

The bytes decide the kind first. A `.pyc` is recognised by its magic number (a 2-byte release number followed by `\r\n`); a magic number this reader does not know is accepted only with a `.pyc` name. A ZIP, including one after a `#!` line as `python -m zipapp` writes it, is a wheel when it has a `<name>.dist-info/WHEEL` member and a zip application when it has a root `__main__.py`; otherwise it is a plain ZIP. Text with a `.py` name is source. A name that suggests a different kind is reported as a conflict.

Archive members are read in memory inside one `max_decoded_bytes` budget. A member that cannot be read (budget, encryption, damage) is listed with the reason and makes the inspect facet partial; the other members are still read.

## Bytecode

The `.pyc` header is read for every release: the magic number, the release a known final-release magic belongs to, the flags word, and either the source modification time and size or the 8-byte source hash (checked or unchecked). Flags importlib rejects are reported.

Code objects are decoded in process only when the exact magic number has an admitted profile. Each profile's tables (opcode names, argument and cache rules, operator names, flag names) were read from that interpreter's own `opcode` and `dis` modules by `scripts/python/bytecode-profile.py` and are stored in `src/python/bytecode/profileData.ts`. Admitted: CPython 3.9 (3425), 3.11 (3495), 3.12 (3531), 3.13 (3571), 3.14 (3627) and 3.15 (3666). Python 3.10 and older releases keep the header only; no profile is guessed from a neighbour.

The marshal reader is written as a hostile-input parser. It never calls an interpreter's `marshal.loads` (which CPython documents as unsafe on untrusted data). Every length is checked against the remaining bytes, nesting stops at CPython's own limit, a load may create at most 5,000,000 objects, and a back-reference to an object that is still being read is refused. A failure keeps the header and reports the byte offset where decoding stopped.

Instructions follow the producing release's `dis.get_instructions`: the same names, arguments and argument text (`NULL + name` or `name + NULL` by release, comparison and binary operators, intrinsics, `to L<n>` labels from 3.13, `lazy`/`eager` imports in 3.15). Two differences are deliberate. A code object constant has no memory address (`<code object f, file "m.py", line 3>`). A set constant keeps its stored order, while a live set iterates in hash order. An opcode the release does not define, or one only created at run time (`INSTRUMENTED_*`, `ENTER_EXECUTOR`), is listed with a problem rather than guessed.

Before 3.11 a code object has no `co_qualname`; the reported qualified name joins the names of the enclosing code objects (`outer.inner`, not `outer.<locals>.inner`).

## Source

Source is parsed by an installed CPython's own `ast` module, in a separate process started with `-I -S -B`, an empty environment, a scratch working directory and only a copy of the bytes. The file is never compiled to code, imported or run. Interpreters are found only at fixed install locations (Homebrew, `/usr/local/bin`, python.org frameworks, `/usr/bin`, `~/.local/bin` and the developer-tools copy `xcode-select` names); the first `python` on `PATH` is never used. The newest is the default; `python` chooses a release, and a release that is not installed is reported as unavailable. A file another grammar accepts is reported as a syntax error, with its location, under the one chosen.

Calls are listed by the dotted name written at the call (`os.path.join`), not by what that name refers to at run time. `__import__`, `importlib.import_module`, `exec`, `eval`, `compile`, `getattr`-style reflection and `runpy` are listed as dynamic, with their first argument when it is a string literal; their targets are not followed. Each list stops at `max_listed`, while its total still counts every fact.

## Wheels and zip applications

A wheel's METADATA and WHEEL are read as headers (multiple-use fields keep every value), `entry_points.txt` as declarations and RECORD as CSV. Each RECORD row's digest is recomputed over the member bytes with the algorithm the row names (urlsafe base64 without padding); rows without a digest (RECORD itself, signatures), algorithms installers refuse (md5, sha1), members RECORD does not list and rows naming no member are reported separately. `RECORD.jws` and `RECORD.p7s` signatures are not verified. Native extensions (`.so`, `.pyd`, `.dylib`, `.dll`) are listed with their digest, binary format from the first bytes and the ABI tag in the name (`cpython-312-darwin`, `abi3`).

A zip application's `#!` line and `__main__.py` are what `python app.pyz` would run; they are reported as declarations. The general `extract_artifact` tool does not open ZIP data after a `#!` line; wheels are extracted by it as ZIPs.

## Decompiling a .pyc

`decompile_python_code` runs [pycdc](https://github.com/zrax/pycdc) (Decompyle++, GPL-3.0), which the owner builds and installs; it is not part of the package. It is found only at `~/.local/bin/pycdc`, `/opt/homebrew/bin/pycdc`, `/usr/local/bin/pycdc` or `/usr/bin/pycdc`, and runs only when the executable's SHA-256 is admitted in `src/python/pycdc.ts`. pycdc has no releases, so the admitted build is commit `b4289760` built for macOS arm64; a different build is reported as unavailable with its path and digest until the lane has passed on it and its digest is added.

The `.pyc` header names the release. Python 2.7 and 3.5-3.13 are read; 3.14 and later, pre-release magic numbers and source files are refused. pycdc gets a copy of the bytes in a scratch directory, an empty environment and `timeout_ms`; the scratch is removed afterwards. Its text comes back inline as inferred Evidence derived from the `.pyc`'s SHA-256. Text over `max_source_bytes` is refused, not cut. When pycdc crashes (it does on some modern bytecode) the tool says so and returns no text.

Then three checks, each `passed`, `failed` or `not_checked` with a reason:

- `decompiler_warnings`: pycdc printed nothing (unsupported opcodes, block-stack warnings) and left no `# WARNING: Decompyle incomplete` marker. Markers are listed by line, messages once each.
- `recompiles`: an installed CPython of the same feature release compiles the text with `compile()` in an isolated child (`-I -S -B`, empty environment). The text is compiled, never run; a syntax error is reported with its line. No matching interpreter, or `check: false`, gives `not_checked`.
- `code_objects_match`: the recompiled module's code objects, by name, against the original's as this reader decodes them (admitted bytecode profiles only: 3.9, 3.11-3.13). Missing and extra names are listed. The target's own bytes never reach an interpreter.

The result is complete only when all three pass. Passing means the text compiles with code objects of the same names; it does not prove the bodies behave like the original. If the checking interpreter times out or crashes, its checks are `not_checked` and the text is still returned. The lane exercises 3.9 and 3.11-3.13 (releases with an installed interpreter and an admitted bytecode profile); pycdc also reads 2.7, 3.5-3.8 and 3.10, which are untested here. pycdc is weak on modern bytecode. In the lane, over 40 standard-library modules per release, every check passed for 13 (3.9), 6 (3.11), 8 (3.12) and 4 (3.13; it usually stops at the first function), and pycdc crashed on 9 (3.9) and 7 (3.11).

## Limits and what is not covered

- Source reconstruction needs the owner-installed pycdc and is partial in practice on 3.9 and later; no other decompiler is admitted.
- Python 3.10 and older bytecode, and pre-release magic numbers, keep the header only.
- Character printability in constant text follows each release's own `str.isprintable` ranges, recorded in its profile with its Unicode version.
- Encrypted members and ZIP64 edge cases follow the shared ZIP reader; duplicate member names keep the first.
- Egg files, sdists (`.tar.gz`), PEP 517 build metadata and `.pth` hooks are not interpreted.
- The hosted public library does not read Python artifacts yet.

## Verification

- `src/python/bytecode/bytecode.test.ts` compiles the committed samples (Unicode, closures, comprehensions, try/except/finally, async, match, `except*`, type parameters, template strings, lazy imports, more than 256 locals) with every installed admitted interpreter, with timestamp, checked-hash and unchecked-hash headers, and compares every code object, constant, exception table entry, instruction, line and position with that interpreter's `dis` (`scripts/python/dis-oracle.py`).
- `src/python/pythonReports.test.ts` builds a pure wheel and a wheel with a C extension with pip and setuptools offline, a wheel with one changed member, and a zip application with a compiled package, and checks unsupported, truncated and corrupted bytecode.
- `src/python/pythonDecompile.test.ts` compiles a small module with every installed interpreter up to 3.13 and runs the real pycdc on it: all checks pass up to 3.12, 3.13 stops with its warnings listed; source, oversized output and 3.14+ are refused.
- `tests/acceptance/applications/python.test.ts` checks that the compiled CLI and real stdio MCP return identical Evidence, including `decompile_python_code`.
- `npm run verify:formats:python` compiles each installed admitted interpreter's whole standard library and compares every instruction with its own `dis`, decompiles a spread of 40 of those modules per release up to 3.13 through the public CLI (counts reported; the checks must agree with themselves; `REA_PYTHON_DECOMPILE_SAMPLE` changes the number), then reads pip-built wheels and a zipapp-built application. `REA_PYTHON_LANE_LIMIT` caps the files per release.
