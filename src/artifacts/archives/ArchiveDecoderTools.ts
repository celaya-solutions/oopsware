import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, realpath } from "node:fs/promises";

import { err, ok, type Result } from "../../domain/result.js";
import { runOwnedCommand } from "../../process/OwnedCommand.js";

/**
 * External decoders an archive reader may run. Each is found only at fixed,
 * conventional install locations, never by the first match on PATH, and is
 * identified by its executable digest and version banner.
 */
export type ArchiveDecoderTool = "xz" | "bsdtar";

const CANDIDATES: Readonly<Record<ArchiveDecoderTool, readonly string[]>> = {
  xz: ["/usr/bin/xz", "/bin/xz", "/usr/local/bin/xz", "/opt/homebrew/bin/xz"],
  bsdtar: [
    "/usr/bin/bsdtar",
    "/usr/local/bin/bsdtar",
    "/opt/homebrew/bin/bsdtar",
    "/opt/homebrew/opt/libarchive/bin/bsdtar",
    "/usr/local/opt/libarchive/bin/bsdtar",
  ],
};

/** A located decoder with its identity evidence. */
export interface ResolvedArchiveDecoder {
  readonly tool: ArchiveDecoderTool;
  readonly executable: string;
  readonly executableSha256: string;
  readonly version: string | null;
}

/** Why a decoder cannot run here; reported, never guessed around. */
export class ArchiveDecoderUnavailable extends Error {
  readonly _tag = "ArchiveDecoderUnavailable";

  constructor(
    readonly tool: ArchiveDecoderTool,
    message: string,
  ) {
    super(message);
  }
}

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_BYTES = 4_096;

const resolved = new Map<
  ArchiveDecoderTool,
  Promise<ResolvedArchiveDecoder | null>
>();

/** Locate and identify one decoder; the lookup is cached for the process. */
export const resolveArchiveDecoder = async (
  tool: ArchiveDecoderTool,
  signal?: AbortSignal,
): Promise<Result<ResolvedArchiveDecoder, ArchiveDecoderUnavailable>> => {
  let pending = resolved.get(tool);
  if (pending === undefined) {
    pending = locate(tool, signal);
    resolved.set(tool, pending);
    // A cancelled or failed probe must not poison later lookups.
    pending.catch(() => resolved.delete(tool));
  }
  const found = await pending;
  return found === null
    ? err(
        new ArchiveDecoderUnavailable(
          tool,
          `No ${tool} executable was found at ${CANDIDATES[tool].join(", ")}.`,
        ),
      )
    : ok(found);
};

const locate = async (
  tool: ArchiveDecoderTool,
  signal?: AbortSignal,
): Promise<ResolvedArchiveDecoder | null> => {
  for (const candidate of CANDIDATES[tool]) {
    try {
      await access(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const executable = await realpath(candidate);
    return {
      tool,
      executable,
      executableSha256: await hashExecutable(executable),
      version: await versionBanner(executable, signal),
    };
  }
  return null;
};

const hashExecutable = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
};

/** First line of `--version`; a failed probe leaves the version unknown. */
const versionBanner = async (
  executable: string,
  signal?: AbortSignal,
): Promise<string | null> => {
  try {
    const snapshot = await runOwnedCommand(
      {
        command: executable,
        arguments: ["--version"],
        runId: randomUUID(),
        hostEnvironment: {},
        ...(signal === undefined ? {} : { signal }),
      },
      {
        timeoutMs: VERSION_TIMEOUT_MS,
        diagnosticBytes: VERSION_OUTPUT_BYTES,
      },
      signal === undefined ? {} : { signal },
    );
    const line = snapshot.stdout.text.split("\n")[0]?.trim() ?? "";
    return line.length === 0 ? null : line;
  } catch {
    return null;
  }
};
