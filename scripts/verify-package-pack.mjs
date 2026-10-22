import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG_IDENTITY } from "../dist/catalogIdentity.js";

import { exec, execNpm } from "./lib/verify-package-core.mjs";
import { parseTarListing } from "./lib/verify-package-listing.mjs";
import { verifyPackedBridge } from "./verify-packed-bridge.mjs";

/** Create a tarball and assert production packaging constraints. */
export async function verifyPackagePack({ root, workspace }) {
  const packDirectory = join(workspace, "pack");
  await mkdir(packDirectory);
  const tarball = join(
    packDirectory,
    (
      await execNpm(["pack", "--silent", "--pack-destination", packDirectory], {
        cwd: root,
      })
    ).stdout.trim(),
  );
  const packedFiles = parseTarListing(
    (await exec("tar", ["-tf", tarball])).stdout,
  );
  const packedManifest = JSON.parse(
    (await exec("tar", ["-xOf", tarball, "package/package.json"])).stdout,
  );
  if (
    packedManifest.scripts?.postinstall !== undefined ||
    packedManifest.dependencies?.["node-pty"] !== undefined ||
    packedManifest.dependencies?.["@lydell/node-pty"] !== "1.1.0"
  )
    throw new Error("package retained a lifecycle-dependent PTY installation");
  if (
    packedManifest.bin?.rea !== "scripts/rea.mjs" ||
    packedManifest.bin?.oopsware !== "scripts/oopsware.mjs"
  )
    throw new Error(
      "package did not expose Oopsware and its rea compatibility command",
    );
  for (const notice of [
    "LICENSE",
    "CREDITS.md",
    "LICENSES/REA-MIT.txt",
    "LICENSES/PolyForm-Noncommercial-1.0.0.txt",
  ])
    if (!packedFiles.includes(`package/${notice}`))
      throw new Error(
        `package omitted required credit or license notice: ${notice}`,
      );
  if (packedManifest.mcpName !== "io.github.celaya-solutions/oopsware")
    throw new Error("package did not retain its MCP Registry ownership marker");
  if (packedFiles.some((path) => path.startsWith("package/.agents/")))
    throw new Error(
      "package included authored skill sources instead of only the generated bundle",
    );
  if (packedFiles.some((path) => path.startsWith("package/.cache/")))
    throw new Error("package included development cache or test metadata");
  const skill = (
    await exec("tar", [
      "-xOf",
      tarball,
      "package/skills/reverse-engineer-anything/SKILL.md",
    ])
  ).stdout;
  if (
    !skill.includes(
      `  tool_count: ${String(CATALOG_IDENTITY.counts.mcp_tools)}\n`,
    ) ||
    skill.includes("  catalog_digest:")
  )
    throw new Error(
      "packaged skill metadata did not match the catalog shipped in the package",
    );
  if (
    packedFiles.some(
      (path) => path.includes("__pycache__") || path.endsWith(".pyc"),
    )
  ) {
    throw new Error("package contained generated Python bytecode");
  }
  await verifyPackedBridge({ tarball, packedFiles });
  return { tarball };
}
