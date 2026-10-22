import { execFile } from "node:child_process";
import {
  access,
  constants,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Debug symbol fixtures for F10, made by real producers: Apple clang and dsymutil
 * (Mach-O and dSYM bundles), the Go linker (linked ELF files with compressed DWARF and
 * a chosen GNU build id) and llvm-objcopy (split .debug files and debug links). The
 * oracle is llvm-dwarfdump. Nothing here installs anything; tests skip without the tools.
 */
export interface SymbolTools {
  readonly clang: string;
  readonly dsymutil: string;
  readonly dwarfdump: string;
  readonly objcopy: string;
  readonly go: string;
}

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const find = async (
  name: string,
  directories: readonly string[],
): Promise<string | null> => {
  for (const directory of directories)
    if (await executable(join(directory, name))) return join(directory, name);
  return null;
};

const LLVM = "/opt/homebrew/opt/llvm/bin";

const findTools = async (): Promise<SymbolTools | null> => {
  if (process.platform !== "darwin") return null;
  const [clang, dsymutil, dwarfdump, objcopy, go] = await Promise.all([
    find("clang++", ["/usr/bin"]),
    find("dsymutil", ["/usr/bin", LLVM]),
    find("llvm-dwarfdump", [LLVM, "/opt/homebrew/bin"]),
    find("llvm-objcopy", [LLVM, "/opt/homebrew/bin"]),
    find("go", ["/opt/homebrew/bin", "/usr/local/go/bin", "/usr/local/bin"]),
  ]);
  if (
    clang === null ||
    dsymutil === null ||
    dwarfdump === null ||
    objcopy === null ||
    go === null
  )
    return null;
  return { clang, dsymutil, dwarfdump, objcopy, go };
};

export const SYMBOL_TOOLS = await findTools();

const tools = (): SymbolTools => {
  if (SYMBOL_TOOLS === null)
    throw new Error(
      "Debug symbol fixtures need Apple clang++, dsymutil, llvm-dwarfdump, llvm-objcopy and go.",
    );
  return SYMBOL_TOOLS;
};

const exec = async (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
  } = {},
): Promise<string> => {
  const { stdout } = await run(command, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: process.env.HOME ?? "/tmp",
      LC_ALL: "C",
      ...options.env,
    },
    maxBuffer: 512 * 1024 ** 2,
  });
  return stdout;
};

export const dwarfdump = (args: readonly string[]): Promise<string> =>
  exec(tools().dwarfdump, args);

const HEADER = "int geo_helper(int);\n";
const FIRST = `#include "shared.h"
namespace geo {
struct Shape { int sides; int perimeter(int len) const; static int count; };
int Shape::count = 0;
int Shape::perimeter(int len) const { return sides * len; }
}
static inline int sq(int x) { return x * x; }
int area(int w, int h) { return sq(w) + sq(h) + geo_helper(w); }
int main(int argc, char **argv) { geo::Shape s{4}; return s.perimeter(argc) + area(argc, 2); }
`;
const SECOND = (factor: number): string => `#include "shared.h"
int geo_helper(int v) { return v * ${factor}; }
`;

export interface MachoBuild {
  readonly binary: string;
  readonly dsym: string;
  /** The DWARF file inside the bundle. */
  readonly dwarfFile: string;
}

/** C++ built with clang, linked, and run through dsymutil; `factor` changes the code (and the UUID). */
export const buildMacho = async (
  directory: string,
  name: string,
  options: {
    readonly dwarf: 2 | 3 | 4 | 5;
    readonly architectures?: readonly string[];
    readonly factor?: number;
  },
): Promise<MachoBuild> => {
  const { clang, dsymutil } = tools();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "shared.h"), HEADER);
  await writeFile(join(directory, `${name}-a.cpp`), FIRST);
  await writeFile(
    join(directory, `${name}-b.cpp`),
    SECOND(options.factor ?? 3),
  );
  const arch = (options.architectures ?? ["arm64"]).flatMap((value) => [
    "-arch",
    value,
  ]);
  const flags = ["-g", `-gdwarf-${options.dwarf}`, "-O1", ...arch];
  // Objects are kept: dsymutil reads them through the debug map.
  await exec(clang, [...flags, "-c", `${name}-a.cpp`, "-o", `${name}-a.o`], {
    cwd: directory,
  });
  await exec(clang, [...flags, "-c", `${name}-b.cpp`, "-o", `${name}-b.o`], {
    cwd: directory,
  });
  await exec(clang, [...arch, `${name}-a.o`, `${name}-b.o`, "-o", name], {
    cwd: directory,
  });
  await exec(dsymutil, [name, "-o", `${name}.dSYM`], { cwd: directory });
  return {
    binary: join(directory, name),
    dsym: join(directory, `${name}.dSYM`),
    dwarfFile: join(
      directory,
      `${name}.dSYM`,
      "Contents/Resources/DWARF",
      name,
    ),
  };
};

const GO_SOURCE = (factor: number): string => `package main

import "fmt"

type Shape struct{ Sides int }

//go:noinline
func (s Shape) Perimeter(n int) int { return s.Sides * n }

//go:noinline
func Area(w, h int) int { return w*h + helper(w) }

//go:noinline
func helper(v int) int { return v * ${factor} }

func main() { s := Shape{4}; fmt.Println(s.Perimeter(2) + Area(3, 4)) }
`;

export interface ElfBuild {
  readonly binary: string;
  /** Debug sections only (llvm-objcopy --only-keep-debug). */
  readonly debug: string;
  /** The binary without debug sections but with a .gnu_debuglink to `debug`. */
  readonly stripped: string;
}

/** A linked Linux ELF built by the Go linker with a chosen GNU build id, then split. */
export const buildElf = async (
  directory: string,
  name: string,
  options: {
    readonly buildId?: string;
    readonly factor?: number;
    readonly arch?: "amd64" | "arm64";
    /** Remove the GNU build id note the Go linker writes by default. */
    readonly noBuildId?: boolean;
  } = {},
): Promise<ElfBuild> => {
  const { go, objcopy } = tools();
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "go.mod"),
    `module fixture${name}\n\ngo 1.22\n`,
  );
  await writeFile(join(directory, "main.go"), GO_SOURCE(options.factor ?? 3));
  const binary = join(directory, name);
  const ldflags =
    options.buildId === undefined ? "-s=false" : `-B=0x${options.buildId}`;
  await exec(go, ["build", `-ldflags=${ldflags}`, "-o", name, "."], {
    cwd: directory,
    env: {
      GOOS: "linux",
      GOARCH: options.arch ?? "amd64",
      CGO_ENABLED: "0",
      GOCACHE: join(directory, ".gocache"),
      GOPATH: join(directory, ".gopath"),
      GOFLAGS: "-mod=mod",
      GOPROXY: "off",
      GOTOOLCHAIN: "local",
    },
  });
  if (options.noBuildId === true)
    await exec(objcopy, ["--remove-section=.note.gnu.build-id", binary]);
  const debug = `${binary}.debug`;
  const stripped = `${binary}.stripped`;
  await exec(objcopy, ["--only-keep-debug", binary, debug]);
  await exec(objcopy, ["--strip-debug", binary, stripped]);
  await exec(objcopy, [`--add-gnu-debuglink=${debug}`, stripped]);
  return { binary, debug, stripped };
};

/** An ELF relocatable object with CodeView-free DWARF: relocations are unapplied. */
export const buildElfObject = async (
  directory: string,
  name: string,
): Promise<string> => {
  const { clang } = tools();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.cpp`), SECOND(5));
  await writeFile(join(directory, "shared.h"), HEADER);
  const out = join(directory, `${name}.o`);
  await exec(
    clang,
    ["--target=x86_64-linux-gnu", "-g", "-c", `${name}.cpp`, "-o", out],
    { cwd: directory },
  );
  return out;
};

export const readBytes = (path: string): Promise<Buffer> => readFile(path);
