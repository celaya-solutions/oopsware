export type NpmReleaseState =
  | { status: "absent" }
  | {
      status: "published";
      integrity: string;
      tag: "latest" | "next";
      taggedVersion: string | null;
      stableVersion: string | null;
    };
export function readNpmRelease(
  version: string,
  request?: (url: string, init: RequestInit) => Promise<Response>,
): Promise<NpmReleaseState>;
export function requireMatchingNpmRelease(
  tarball: string,
  version: string,
  published: NpmReleaseState,
): Promise<void>;
export function stableUpdateVersion(
  version: string,
  published: NpmReleaseState,
): string;
export function waitForNpmRelease(
  version: string,
  lookup?: (version: string) => Promise<NpmReleaseState>,
  pause?: (milliseconds: number) => Promise<unknown>,
): Promise<Extract<NpmReleaseState, { status: "published" }>>;
