import { mkdir, chown } from "node:fs/promises";

// Railway mounts its volume as root. Prepare only our directory, then drop privileges.
const directory = process.env.REA_PUBLIC_DATA ?? "/data/rea-public";
await mkdir(directory, { recursive: true, mode: 0o700 });
if (process.platform === "linux" && process.getuid?.() === 0) {
  await chown(directory, 1000, 1000);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
await import("../dist-hosted/server.mjs");
