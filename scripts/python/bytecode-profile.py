"""Print the bytecode facts one CPython reports about itself, as JSON.

Run with `-I` under each interpreter whose .pyc files Oopsware decodes. Only the
interpreter's own `opcode`, `dis` and `importlib` modules are read; no target is
loaded. The output is the data source for src/python/bytecode/profiles.ts.
"""

import dis
import importlib.util
import json
import marshal
import opcode
import sys
import unicodedata


def cache_size(name):
    get = getattr(dis, "_get_cache_size", None)
    if get is not None:
        return get(name)
    entries = getattr(opcode, "_inline_cache_entries", None)
    if entries is None:
        return 0
    if isinstance(entries, dict):
        return entries.get(name, 0)
    code = opcode.opmap.get(name)
    return entries[code] if code is not None and code < len(entries) else 0


def names(attribute):
    values = getattr(dis, attribute, None)
    return None if values is None else [str(value) for value in values]


def common_constants():
    values = getattr(dis, "_common_constants", None)
    if values is None:
        return None
    return [value.__name__ if isinstance(value, type) else repr(value) for value in values]


def printable_ranges():
    """[start, end) code point ranges str.isprintable accepts, so repr() is exact per release."""
    ranges = []
    start = None
    for point in range(0x110000):
        ok = not 0xD800 <= point < 0xE000 and chr(point).isprintable()
        if ok and start is None:
            start = point
        elif not ok and start is not None:
            ranges.append([start, point])
            start = None
    if start is not None:
        ranges.append([start, 0x110000])
    return ranges


opnames = list(opcode.opname)
base = {name: code for name, code in opcode.opmap.items()}
specialized = set(getattr(opcode, "_specialized_opmap", {}) or {})
specialized |= set(getattr(opcode, "_specialized_instructions", []) or [])
has_argument = opcode.HAVE_ARGUMENT
hasarg = getattr(opcode, "hasarg", None)
profile = {
    "version": "%d.%d" % sys.version_info[:2],
    "release": "%d.%d.%d" % sys.version_info[:3],
    "magic": int.from_bytes(importlib.util.MAGIC_NUMBER[:2], "little"),
    "marshal_version": marshal.version,
    "opcodes": {
        name: code
        for name, code in sorted(base.items(), key=lambda item: item[1])
        if name not in specialized
    },
    "has_argument": has_argument,
    "hasarg": sorted(hasarg) if hasarg is not None else None,
    "cache": {name: cache_size(name) for name in base if name not in specialized and cache_size(name)},
    "sets": {
        key: sorted(getattr(opcode, key))
        for key in (
            "hasconst", "hasname", "hasjrel", "hasjabs", "haslocal",
            "hascompare", "hasfree", "hasexc", "hasjump",
        )
        if getattr(opcode, key, None) is not None
    },
    "cmp_op": list(opcode.cmp_op),
    "nb_ops": [entry[1] for entry in getattr(opcode, "_nb_ops", [])],
    "intrinsic_1": names("_intrinsic_1_descs"),
    "intrinsic_2": names("_intrinsic_2_descs"),
    "common_constants": common_constants(),
    "special_methods": names("_special_method_names"),
    "function_attr_flags": names("FUNCTION_ATTR_FLAGS"),
    "make_function_flags": names("MAKE_FUNCTION_FLAGS"),
    "format_value_converters": (
        [entry[1] for entry in dis.FORMAT_VALUE_CONVERTERS]
        if hasattr(dis, "FORMAT_VALUE_CONVERTERS") else None
    ),
    "unicode_version": unicodedata.unidata_version,
    "printable": printable_ranges(),
    "code_flags": {str(bit): name for bit, name in sorted(dis.COMPILER_FLAG_NAMES.items())},
}
json.dump(profile, sys.stdout, indent=1, sort_keys=False)
print()
