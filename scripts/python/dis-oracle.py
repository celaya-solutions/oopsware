"""Describe .pyc files the way this interpreter's own dis module reads them.

Usage: python -I dis-oracle.py FILE.pyc...  (JSON on stdout)

Test and lane oracle only. It unmarshals the files, so run it solely on files
the same interpreter just produced from known sources, never on targets.
Code objects are listed in pre-order through co_consts (and any containers in
it), matching Oopsware's own walk.
"""

import dis
import importlib.util
import json
import marshal
import re
import sys

# Only a code object's own repr carries an address; string constants keep theirs.
ADDRESS = re.compile(r"(<code object .+?) at 0x[0-9a-fA-F]+(?=, file )")
MODERN = sys.version_info >= (3, 13)


def walk(code, into):
    into.append(code)
    for value in code.co_consts:
        nested(value, into)


def nested(value, into):
    if hasattr(value, "co_code"):
        walk(value, into)
    elif isinstance(value, (tuple, list, set, frozenset)):
        for item in value:
            nested(item, into)


def stable(value):
    """repr() with set items sorted by their repr: a live set iterates in hash order."""
    if isinstance(value, (set, frozenset)):
        if not value:
            return repr(value)
        body = ", ".join(sorted(stable(item) for item in value))
        return "{%s}" % body if isinstance(value, set) else "frozenset({%s})" % body
    if isinstance(value, tuple):
        items = [stable(item) for item in value]
        return "(%s,)" % items[0] if len(items) == 1 else "(%s)" % ", ".join(items)
    return ADDRESS.sub(r"\1", repr(value))


def instruction(entry):
    described = {
        "offset": entry.offset,
        "opname": entry.opname,
        "opcode": entry.opcode,
        "arg": entry.arg,
        "argrepr": ADDRESS.sub(r"\1", entry.argrepr),
    }
    if entry.argrepr and entry.opcode in dis.hasconst and isinstance(entry.argval, (tuple, set, frozenset)):
        described["argrepr"] = stable(entry.argval)
    if MODERN:
        described["start_offset"] = entry.start_offset
        described["starts_line"] = entry.starts_line
        described["line"] = entry.line_number
    else:
        described["starts_line"] = entry.starts_line
    positions = getattr(entry, "positions", None)
    if positions is not None:
        described["positions"] = list(positions)
    if entry.opcode in dis.hasjrel or entry.opcode in dis.hasjabs:
        described["jump_target"] = entry.argval
    return described


def describe(code):
    described = {
        "name": code.co_name,
        "qualname": getattr(code, "co_qualname", None),
        "firstlineno": code.co_firstlineno,
        "argcount": code.co_argcount,
        "posonlyargcount": code.co_posonlyargcount,
        "kwonlyargcount": code.co_kwonlyargcount,
        "nlocals": code.co_nlocals,
        "stacksize": code.co_stacksize,
        "flags": code.co_flags,
        "names": list(code.co_names),
        "varnames": list(code.co_varnames),
        "cellvars": list(code.co_cellvars),
        "freevars": list(code.co_freevars),
        "filename": code.co_filename,
        "code_bytes": len(code.co_code),
        "consts": [stable(value) for value in code.co_consts],
        "instructions": [instruction(entry) for entry in dis.get_instructions(code)],
    }
    if hasattr(code, "co_exceptiontable"):
        described["exception_table"] = [
            [entry.start, entry.end, entry.target, entry.depth, entry.lasti]
            for entry in dis._parse_exception_table(code)
        ]
    return described


result = {"version": "%d.%d" % sys.version_info[:2],
          "magic": int.from_bytes(importlib.util.MAGIC_NUMBER[:2], "little"),
          "files": []}
for path in sys.argv[1:]:
    with open(path, "rb") as handle:
        data = handle.read()
    header = 16 if sys.version_info >= (3, 7) else 12
    module = marshal.loads(data[header:])
    codes = []
    walk(module, codes)
    result["files"].append({"path": path, "codes": [describe(code) for code in codes]})
json.dump(result, sys.stdout)
