import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await mkdir("dist-hosted", { recursive: true });
await build({
  entryPoints: {
    server: "src/hosted/main.ts",
    worker: "src/hosted/worker.ts",
    library: "src/hosted/Server.ts",
  },
  outdir: "dist-hosted",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node24",
  format: "esm",
});
await cp("hosted/public", "dist-hosted/public", { recursive: true });

// Browser bundles: library app, shared site chrome + analytics, and the formats filter.
await build({
  entryPoints: [
    "hosted/public/app.js",
    "hosted/public/site.js",
    "hosted/public/formats.js",
  ],
  outdir: "dist-hosted/public",
  bundle: true,
  minify: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
});

// Self-host the three variable fonts (SIL OFL) so the site makes no external requests.
const fonts = {
  "@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2":
    "archivo-latin-wght-normal.woff2",
  "@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2":
    "atkinson-hyperlegible-next-latin-wght-normal.woff2",
  "@fontsource-variable/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-wght-normal.woff2":
    "atkinson-hyperlegible-mono-latin-wght-normal.woff2",
};
await mkdir("dist-hosted/public/fonts", { recursive: true });
for (const [from, to] of Object.entries(fonts))
  await cp(`node_modules/${from}`, `dist-hosted/public/fonts/${to}`);
