import { readdirSync } from "node:fs";
import { join } from "node:path";

export const MAC_HOPPER_APPLICATION_DIRECTORY = "/Applications";
export const MAC_HOPPER_APPLICATION_NAME = "Hopper Disassembler.app";
export const MAC_HOPPER_USER_APPLICATIONS_DIRECTORY = "Applications";

export const MAC_HOPPER_SYSTEM_LAUNCHER = join(
  MAC_HOPPER_APPLICATION_DIRECTORY,
  MAC_HOPPER_APPLICATION_NAME,
  "Contents/MacOS/hopper",
);

export const macHopperUserApplicationPath = (homeDirectory: string): string =>
  join(
    homeDirectory,
    MAC_HOPPER_USER_APPLICATIONS_DIRECTORY,
    MAC_HOPPER_APPLICATION_NAME,
  );

export const macHopperApplicationRoots = (
  homeDirectory: string,
): readonly string[] => [
  MAC_HOPPER_APPLICATION_DIRECTORY,
  join(homeDirectory, MAC_HOPPER_USER_APPLICATIONS_DIRECTORY),
];

export const macHopperCanonicalLauncherCandidates = (
  homeDirectory: string,
): readonly string[] => [
  MAC_HOPPER_SYSTEM_LAUNCHER,
  join(macHopperUserApplicationPath(homeDirectory), "Contents/MacOS/hopper"),
];

/** Build deterministic candidates from the discovered app bundle names. */
export const macHopperRenamedLauncherCandidates = (
  homeDirectory: string,
  bundleNamesByRoot: ReadonlyMap<string, readonly string[]>,
): readonly string[] =>
  macHopperApplicationRoots(homeDirectory).flatMap((root) =>
    [...new Set(bundleNamesByRoot.get(root) ?? [])]
      .filter(
        (name) =>
          /^Hopper.*\.app$/iu.test(name) &&
          name.toLocaleLowerCase("en-US") !==
            MAC_HOPPER_APPLICATION_NAME.toLocaleLowerCase("en-US"),
      )
      .sort()
      .map((name) => join(root, name, "Contents/MacOS/hopper")),
  );

const localBundleNames = (root: string): readonly string[] => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && /^Hopper.*\.app$/iu.test(entry.name),
      )
      .map(({ name }) => name);
  } catch (cause: unknown) {
    // Missing or unreadable optional app directories contain no candidates.
    void cause;
    return [];
  }
};

/** Yield canonical paths first; enumerate renamed bundles only if needed. */
export function* macHopperLauncherCandidates(
  homeDirectory: string,
): Generator<string> {
  yield* macHopperCanonicalLauncherCandidates(homeDirectory);
  for (const root of macHopperApplicationRoots(homeDirectory))
    yield* macHopperRenamedLauncherCandidates(
      homeDirectory,
      new Map([[root, localBundleNames(root)]]),
    );
}
