import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: ["web/src/main.tsx"],
  outfile: "web/dashboard.js",
  bundle: true,
  minify: true,
  sourcemap: false,
  format: "esm",
  target: ["safari17", "chrome120", "firefox120"],
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
  logLevel: "info",
  loader: { ".woff2": "dataurl" },
  plugins: [
    {
      name: "workspace-theme",
      setup(builder) {
        builder.onLoad(
          { filter: /web[\\/]src[\\/]styles\.css$/ },
          async ({ path }) => ({
            contents: (
              await postcss([tailwindcss()]).process(
                await readFile(path, "utf8"),
                { from: path },
              )
            ).css,
            loader: "css",
            resolveDir: fileURLToPath(new URL("../web/src/", import.meta.url)),
          }),
        );
      },
    },
  ],
});
