import { execFile } from "node:child_process";
import { access, constants, cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Real .NET SDK producer for the ILSpy fixtures: `dotnet build` compiles the
 * committed C# projects at test time, offline (no package references); no
 * assembly is committed.
 */
const SDK_ROOTS = [
  "/opt/homebrew/opt/dotnet@8/libexec",
  "/usr/local/share/dotnet",
  "/usr/share/dotnet",
];

const sources = resolve(import.meta.dirname, "dotnet");

export const dotnetSdk = async (): Promise<string | null> => {
  for (const root of SDK_ROOTS) {
    try {
      await access(join(root, "dotnet"), constants.X_OK);
      await access(join(root, "sdk"), constants.R_OK);
      return join(root, "dotnet");
    } catch {
      // Try the next install root.
    }
  }
  return null;
};

export interface DotnetFixtures {
  /** Demo.IShape, Demo.Circle (with nested Unit) and Demo.Tools. */
  readonly shapes: string;
  /** Uses.Gallery, which references Shapes.dll. */
  readonly uses: string;
  /** The folder holding Shapes.dll, for reference_paths. */
  readonly shapesDirectory: string;
}

/** Build both projects into `root` with an isolated HOME and no build servers left running. */
export const buildDotnetFixtures = async (
  dotnet: string,
  root: string,
): Promise<DotnetFixtures> => {
  const work = join(root, "src");
  await cp(sources, work, { recursive: true });
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const env = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_CLI_HOME: home,
  };
  const out = (name: string) => join(root, "out", name);
  for (const name of ["Shapes", "Uses"])
    await run(
      dotnet,
      [
        "build",
        join(work, name, `${name}.csproj`),
        "-c",
        "Release",
        "-o",
        out(name),
        "-nodeReuse:false",
        "-p:UseSharedCompilation=false",
      ],
      { env, maxBuffer: 16 * 1024 ** 2 },
    );
  return {
    shapes: join(out("Shapes"), "Shapes.dll"),
    uses: join(out("Uses"), "Uses.dll"),
    shapesDirectory: out("Shapes"),
  };
};
