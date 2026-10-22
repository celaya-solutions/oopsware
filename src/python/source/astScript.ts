/**
 * Runs inside the selected CPython with `-I -S -B` and an empty environment:
 * argv[1] is a scratch copy of the source, argv[2] the per-list limit. The
 * file is parsed by `ast.parse` (which reads its PEP 263 declaration) and
 * walked; it is never compiled to code, imported or run. Output is one JSON
 * object on stdout. Compatible with Python 3.9 and newer.
 */
export const AST_FACTS_SCRIPT = String.raw`
import ast, json, sys, tokenize, io

path, limit = sys.argv[1], int(sys.argv[2])
with open(path, "rb") as handle:
    data = handle.read()

out = {"python": "%d.%d.%d" % sys.version_info[:3]}
try:
    encoding, _ = tokenize.detect_encoding(io.BytesIO(data).readline)
    out["encoding"] = encoding
except SyntaxError as error:
    out["encoding"] = None
    out["encoding_error"] = str(error)

lists = {}
totals = {}
def add(key, value):
    totals[key] = totals.get(key, 0) + 1
    bucket = lists.setdefault(key, [])
    if len(bucket) < limit:
        bucket.append(value)

text = None
if out["encoding"] is not None:
    try:
        text = data.decode(out["encoding"])
        if text.startswith("﻿"):
            text = text[1:]
    except (UnicodeDecodeError, LookupError) as error:
        out["decode_error"] = str(error)

def segment(node):
    if text is not None:
        found = ast.get_source_segment(text, node)
        if found is not None:
            return found
    try:
        return ast.unparse(node)
    except Exception:
        return None

def where(node):
    return {"line": getattr(node, "lineno", None), "column": getattr(node, "col_offset", None),
            "end_line": getattr(node, "end_lineno", None), "end_column": getattr(node, "end_col_offset", None)}

def dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None

def literal(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None

DYNAMIC = {"__import__": "import", "importlib.import_module": "import", "import_module": "import",
           "exec": "exec", "eval": "eval", "compile": "compile", "getattr": "reflection",
           "setattr": "reflection", "delattr": "reflection", "globals": "reflection",
           "locals": "reflection", "vars": "reflection", "runpy.run_module": "import",
           "runpy.run_path": "import", "importlib.__import__": "import"}

class Walker(ast.NodeVisitor):
    def __init__(self):
        self.scope = []
        self.guards = []

    def qualname(self, name):
        return ".".join(self.scope + [name])

    def scope_name(self):
        return ".".join(self.scope) if self.scope else "<module>"

    def visit_Import(self, node):
        for alias in node.names:
            add("imports", dict(where(node), kind="import", module=alias.name, name=None,
                                asname=alias.asname, level=0, scope=self.scope_name(),
                                lazy=bool(getattr(node, "is_lazy", 0)), guarded=list(self.guards)))

    def visit_ImportFrom(self, node):
        for alias in node.names:
            add("imports", dict(where(node), kind="from", module=node.module, name=alias.name,
                                asname=alias.asname, level=node.level or 0, scope=self.scope_name(),
                                lazy=bool(getattr(node, "is_lazy", 0)), guarded=list(self.guards)))

    def definition(self, node, kind):
        entry = dict(where(node), kind=kind, name=node.name, qualname=self.qualname(node.name),
                     scope=self.scope_name(),
                     decorators=[segment(item) for item in node.decorator_list],
                     docstring=ast.get_docstring(node, clean=True))
        params = getattr(node, "type_params", None)
        entry["type_params"] = [segment(item) for item in params] if params else []
        if kind == "class":
            entry["bases"] = [segment(item) for item in node.bases]
            entry["keywords"] = [segment(item) for item in node.keywords]
        else:
            entry["arguments"] = segment(node.args) if node.args is not None else None
            entry["returns"] = segment(node.returns) if node.returns is not None else None
        if entry.get("docstring") is not None and len(entry["docstring"]) > 2000:
            entry["docstring"] = entry["docstring"][:2000]
        add("definitions", entry)
        for item in node.decorator_list:
            self.visit(item)
        self.scope.append(node.name)
        for child in node.body:
            self.visit(child)
        self.scope.pop()
        if kind == "class":
            for item in node.bases + node.keywords:
                self.visit(item)
        else:
            self.visit(node.args)
            if node.returns is not None:
                self.visit(node.returns)

    def visit_FunctionDef(self, node):
        self.definition(node, "function")

    def visit_AsyncFunctionDef(self, node):
        self.definition(node, "async-function")

    def visit_ClassDef(self, node):
        self.definition(node, "class")

    def visit_Lambda(self, node):
        totals["lambdas"] = totals.get("lambdas", 0) + 1
        self.generic_visit(node)

    def guarded(self, label, node, fields):
        self.guards.append(label)
        for field in fields:
            for child in getattr(node, field):
                self.visit(child)
        self.guards.pop()

    def visit_If(self, node):
        self.visit(node.test)
        test = segment(node.test) or ""
        label = "TYPE_CHECKING" if "TYPE_CHECKING" in test else "if"
        if (isinstance(node.test, ast.Compare) and isinstance(node.test.left, ast.Name)
                and node.test.left.id == "__name__" and len(node.test.comparators) == 1
                and literal(node.test.comparators[0]) == "__main__" and not self.scope):
            out.setdefault("main_guards", []).append(where(node))
            label = "__main__"
        self.guarded(label, node, ["body"])
        self.guarded("else", node, ["orelse"])

    def visit_Try(self, node):
        self.guarded("try", node, ["body"])
        for handler in node.handlers:
            self.guarded("except", handler, ["body"])
        self.guarded("else", node, ["orelse"])
        self.guarded("finally", node, ["finalbody"])

    visit_TryStar = visit_Try

    def visit_Call(self, node):
        callee = dotted(node.func)
        if callee is None:
            totals["unresolved_calls"] = totals.get("unresolved_calls", 0) + 1
        else:
            add("calls", dict(where(node), callee=callee, scope=self.scope_name()))
            kind = DYNAMIC.get(callee)
            if kind is not None:
                argument = literal(node.args[0]) if node.args else None
                add("dynamic", dict(where(node), kind=kind, callee=callee, scope=self.scope_name(),
                                    literal=argument, source=segment(node)))
        self.generic_visit(node)

    def visit_Assign(self, node):
        if not self.scope:
            for target in node.targets:
                if isinstance(target, ast.Name):
                    add("assignments", dict(where(node), name=target.id))
                    if target.id == "__all__" and isinstance(node.value, (ast.List, ast.Tuple)):
                        values = [literal(item) for item in node.value.elts]
                        out["all"] = values if all(v is not None for v in values) else None
        self.generic_visit(node)

    def visit_Global(self, node):
        for name in node.names:
            add("globals", dict(where(node), name=name, scope=self.scope_name(), kind="global"))

    def visit_Nonlocal(self, node):
        for name in node.names:
            add("globals", dict(where(node), name=name, scope=self.scope_name(), kind="nonlocal"))

if "encoding_error" not in out and "decode_error" not in out:
    try:
        tree = ast.parse(data, filename="<target>", type_comments=False)
    except SyntaxError as error:
        out["syntax_error"] = {"message": error.msg, "line": error.lineno, "column": error.offset,
                               "end_line": getattr(error, "end_lineno", None),
                               "end_column": getattr(error, "end_offset", None),
                               "text": (error.text or "")[:500]}
    except (RecursionError, MemoryError) as error:
        out["parser_limit"] = type(error).__name__
    except ValueError as error:
        out["syntax_error"] = {"message": str(error), "line": None, "column": None,
                               "end_line": None, "end_column": None, "text": ""}
    else:
        out["docstring"] = ast.get_docstring(tree, clean=True)
        if out["docstring"] is not None and len(out["docstring"]) > 2000:
            out["docstring"] = out["docstring"][:2000]
        out["nodes"] = sum(1 for _ in ast.walk(tree))
        try:
            Walker().visit(tree)
        except RecursionError:
            out["walk_limit"] = "RecursionError"
out["lists"] = lists
out["totals"] = totals
sys.stdout.write(json.dumps(out))
`;
