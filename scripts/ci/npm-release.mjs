import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { prerelease, valid } from "semver";
import { verifyPublishedPackageIntegrity } from "./verified-package.mjs";

const { name: packageName } = z
  .object({ name: z.string().min(1) })
  .parse(
    JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ),
  );
const registryUrl = `https://registry.npmjs.org/${packageName.replace("/", "%2f")}`;

/** Prereleases publish under next; stable versions under latest. */
function releaseNpmTag(version) {
  if (valid(version) !== version)
    throw new Error("Expected an exact SemVer version.");
  return prerelease(version) === null ? "latest" : "next";
}

/** Parse one npm metadata snapshot; errors and malformed records are never absence. */
export async function readNpmRelease(version, request = fetch) {
  const tag = releaseNpmTag(version);
  const response = await request(registryUrl, {
    headers: {
      Accept: "application/vnd.npm.install-v1+json",
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return { status: "absent" };
  if (!response.ok)
    throw new Error(`npm registry lookup failed: HTTP ${response.status}`);
  const metadata = z
    .object({
      name: z.literal(packageName),
      versions: z.record(z.string(), z.unknown()),
      "dist-tags": z.record(z.string(), z.string()),
    })
    .parse(await response.json());
  if (!Object.hasOwn(metadata.versions, version)) return { status: "absent" };
  const published = z
    .object({
      name: z.literal(packageName),
      version: z.literal(version),
      dist: z.object({ integrity: z.string().min(1) }),
    })
    .parse(metadata.versions[version]);
  return {
    status: "published",
    integrity: published.dist.integrity,
    tag,
    taggedVersion: metadata["dist-tags"][tag] ?? null,
    stableVersion: metadata["dist-tags"].latest ?? null,
  };
}

/** The updater follows stable latest even when the candidate is published on next. */
export function stableUpdateVersion(version, published) {
  if (published.status !== "published" || published.taggedVersion !== version)
    throw new Error(`npm does not select ${version} on its release channel`);
  const stable = published.stableVersion;
  if (
    typeof stable !== "string" ||
    valid(stable) !== stable ||
    prerelease(stable) !== null
  )
    throw new Error(
      "npm latest does not select a stable release for the update canary",
    );
  return stable;
}

/** Validate content before accepting a previously published or newly visible version. */
export async function requireMatchingNpmRelease(tarball, version, published) {
  if (published.status !== "published")
    throw new Error(`${packageName}@${version} is not published`);
  await verifyPublishedPackageIntegrity(tarball, published.integrity);
  if (published.taggedVersion !== version)
    throw new Error(
      `Expected npm ${published.tag} to select ${version}, observed ${published.taggedVersion ?? "missing"}; refusing to change an existing dist-tag`,
    );
}

/** Retry only confirmed absence during the existing registry propagation window. */
export async function waitForNpmRelease(
  version,
  lookup = readNpmRelease,
  pause = setTimeout,
) {
  const attempts = 120;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const published = await lookup(version);
    if (published.status === "published") return published;
    if (attempt < attempts) await pause(15_000);
  }
  throw new Error(
    `${packageName}@${version} was not visible on npm after 120 attempts over 30 minutes`,
  );
}

async function main() {
  const [operation, tarball, version, ...extra] = process.argv.slice(2);
  if (
    !["inspect", "verify"].includes(operation) ||
    tarball === undefined ||
    version === undefined ||
    extra.length
  )
    throw new Error(
      "Usage: node scripts/ci/npm-release.mjs inspect|verify <qualified-tarball> <version>",
    );
  const published =
    operation === "inspect"
      ? await readNpmRelease(version)
      : await waitForNpmRelease(version);
  if (published.status === "published")
    await requireMatchingNpmRelease(tarball, version, published);
  if (operation === "inspect") {
    await appendFile(
      z.string().min(1).parse(process.env.GITHUB_OUTPUT),
      `published=${published.status === "published"}\n`,
    );
  } else if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `npm: ${packageName}@${version} is published, matches the qualified tarball, and is selected by ${published.tag}.\n`,
    );
  }
  process.stdout.write(`${JSON.stringify({ version, ...published })}\n`);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
