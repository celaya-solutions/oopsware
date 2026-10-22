import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { basename } from "node:path";
import type { FileIdentityReader } from "../application/project/ProjectService.js";
import { WebFailure } from "./WebFailure.js";

const BUNDLE = /\.(?:app|framework|bundle|appex|xpc|plugin)$/i;

/** Describe a hand-added project target; files are hashed, folders keep an unknown digest. */
export const readFileIdentity: FileIdentityReader = async (path, signal) => {
  const info = await lstat(path);
  const name = basename(path) || path;
  if (info.isSymbolicLink())
    throw new WebFailure(
      400,
      "unsupported_target",
      "Add the file a link points to, not the link itself.",
    );
  if (info.isDirectory())
    return {
      name,
      kind: BUNDLE.test(path.replace(/[\\/]+$/, "")) ? "bundle" : "folder",
      size: null,
      sha256: null,
    };
  if (!info.isFile())
    throw new WebFailure(
      400,
      "unsupported_target",
      "Only regular files, folders and bundles can be project targets.",
    );
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
      if (position > info.size)
        throw new WebFailure(
          409,
          "target_changed",
          "The file grew while it was being read. Try again when it is finished.",
        );
    }
    return { name, kind: "file", size: position, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
};
