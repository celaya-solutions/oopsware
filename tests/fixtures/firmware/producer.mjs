import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  truncate,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const mode = process.env.REA_FIRMWARE_FIXTURE_MODE;
const engine = process.env.REA_FIRMWARE_FIXTURE_ENGINE;
const banner = process.env.REA_FIRMWARE_FIXTURE_VERSION;
if (args.includes("--version")) {
  console.log(
    mode === "version"
      ? "unsupported"
      : banner !== undefined && banner.length > 0
        ? banner
        : engine === "binwalk"
          ? "binwalk 3.1.0"
          : "26.6.4",
  );
} else if (mode === "stall") {
  setInterval(() => {}, 1000);
} else if (mode === "startup") {
  console.error("Landlock sandbox is not available on this fixture host");
  process.exitCode = 1;
} else if (mode === "missing-report") {
  console.error("Producer forgot its report");
} else {
  const input = args.at(-1);
  const bytes = await readFile(input);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const reportPath =
    args[args.indexOf(engine === "binwalk" ? "--log" : "--report") + 1];
  if (engine === "binwalk") {
    await writeFile(
      reportPath,
      JSON.stringify([
        {
          Analysis: {
            file_path: mode === "wrong-input" ? "/tmp/another.bin" : input,
            file_map: [
              {
                id: "hit",
                offset: 2,
                size: mode === "bounds" ? bytes.length : 4,
                name: "gzip",
                confidence: 250,
                description: "fixture signature",
                always_display: false,
                extraction_declined: false,
              },
            ],
            extractions: {},
          },
        },
      ]),
    );
  } else {
    const output = args[args.indexOf("--extract-dir") + 1];
    await mkdir(output, { recursive: true });
    const child =
      mode === "reserved-name"
        ? join(output, "$input")
        : join(output, "rootfs", "config");
    await mkdir(join(output, "rootfs"));
    const content = Buffer.from("firmware=true\n");
    if (
      mode !== "missing-file" &&
      mode !== "depth-reentry" &&
      mode !== "depth-orphan"
    )
      await writeFile(child, mode === "budget" ? Buffer.alloc(10000) : content);
    if (mode === "link") await symlink("/etc/passwd", join(output, "escape"));
    const childHash = createHash("sha256").update(content).digest("hex");
    const depth =
      mode === "depth" || mode === "depth-reentry" || mode === "depth-orphan"
        ? Number(args[args.indexOf("--depth") + 1])
        : 1;
    const stat = (path, size, isDir = false) => ({
      __typename__: "StatReport",
      path,
      size,
      is_file: !isDir,
      is_dir: isDir,
      is_link: false,
      link_target: null,
    });
    const task = (path, level, id) => ({
      path,
      depth: level,
      blob_id: id,
      is_multi_file: false,
    });
    const hash = (value) => ({ __typename__: "HashReport", sha256: value });
    const childTask = task(child, depth, "gzip-id");
    if (mode === "nested-unknown") {
      const nestedUnknownRecords = [
        {
          task: childTask,
          reports: [
            stat(child, content.length),
            hash(childHash),
            {
              __typename__: "UnknownChunkReport",
              id: "unknown-id",
              start_offset: 0,
              end_offset: content.length,
              size: content.length,
            },
          ],
          subtasks: [],
        },
        {
          task: task(input, 0, ""),
          reports: [
            stat(input, bytes.length),
            hash(sha256),
            {
              __typename__: "ChunkReport",
              id: "gzip-id",
              start_offset: 0,
              end_offset: bytes.length,
              size: bytes.length,
              handler_name: "gzip",
              is_encrypted: false,
              extraction_reports: [],
            },
          ],
          subtasks: [childTask],
        },
      ];
      await writeFile(reportPath, JSON.stringify(nestedUnknownRecords));
    }
    if (mode === "nested-unknown-oversized") {
      // The child exceeds the firmware input limit, so a fresh run cannot
      // accept it even though the unknown chunk's range is small.
      const oversized = 128 * 1024 * 1024 + 1;
      await truncate(child, oversized);
      const oversizedDigest = createHash("sha256");
      for await (const chunk of createReadStream(child))
        oversizedDigest.update(chunk);
      const oversizedHash = oversizedDigest.digest("hex");
      const nestedUnknownRecords = [
        {
          task: childTask,
          reports: [
            stat(child, oversized),
            hash(oversizedHash),
            {
              __typename__: "UnknownChunkReport",
              id: "unknown-id",
              start_offset: 0,
              end_offset: content.length,
              size: content.length,
            },
          ],
          subtasks: [],
        },
        {
          task: task(input, 0, ""),
          reports: [
            stat(input, bytes.length),
            hash(sha256),
            {
              __typename__: "ChunkReport",
              id: "gzip-id",
              start_offset: 0,
              end_offset: bytes.length,
              size: bytes.length,
              handler_name: "gzip",
              is_encrypted: false,
              extraction_reports: [],
            },
          ],
          subtasks: [childTask],
        },
      ];
      await writeFile(reportPath, JSON.stringify(nestedUnknownRecords));
    }
    if (mode === "depth-orphan") {
      // A depth-limited directory with nothing published under it cannot
      // re-root a fresh run.
      const mid = join(output, "rootfs", "config");
      await mkdir(mid, { recursive: true });
      const midTask = task(mid, depth, "gzip-id");
      const orphanRecords = [
        {
          task: midTask,
          reports: [stat(mid, 0, true)],
          subtasks: [],
        },
        {
          task: task(input, 0, ""),
          reports: [
            stat(input, bytes.length),
            hash(sha256),
            {
              __typename__: "ChunkReport",
              id: "gzip-id",
              start_offset: 0,
              end_offset: bytes.length,
              size: bytes.length,
              handler_name: "gzip",
              is_encrypted: false,
              extraction_reports: [],
            },
          ],
          subtasks: [midTask],
        },
      ];
      await writeFile(reportPath, JSON.stringify(orphanRecords));
    }
    if (mode === "depth-reentry") {
      // A depth-limited directory with two published children that can each
      // re-root a fresh run, proving neither target is lost during indexing.
      const mid = join(output, "rootfs", "config");
      const innerPath = join(mid, "inner.gz");
      const secondPath = join(mid, "second.gz");
      await mkdir(mid, { recursive: true });
      await writeFile(innerPath, content);
      await writeFile(secondPath, content);
      const innerTask = task(innerPath, depth + 1, "inner-id");
      const secondTask = task(secondPath, depth + 1, "second-id");
      const midTask = {
        ...task(mid, depth, "gzip-id"),
        is_multi_file: true,
      };
      const depthReentryRecords = [
        {
          task: innerTask,
          reports: [stat(innerPath, content.length), hash(childHash)],
          subtasks: [],
        },
        {
          task: secondTask,
          reports: [stat(secondPath, content.length), hash(childHash)],
          subtasks: [],
        },
        {
          task: midTask,
          reports: [
            stat(mid, 0, true),
            {
              __typename__: "MultiFileReport",
              id: "gzip-id",
              handler_name: "gzip",
              name: "config",
              paths: [innerPath, secondPath],
              extraction_reports: [],
            },
          ],
          subtasks: [innerTask, secondTask],
        },
        {
          task: task(input, 0, ""),
          reports: [
            stat(input, bytes.length),
            hash(sha256),
            {
              __typename__: "ChunkReport",
              id: "gzip-id",
              start_offset: 0,
              end_offset: bytes.length,
              size: bytes.length,
              handler_name: "gzip",
              is_encrypted: false,
              extraction_reports: [],
            },
          ],
          subtasks: [midTask],
        },
      ];
      await writeFile(reportPath, JSON.stringify(depthReentryRecords));
      process.exitCode = 0;
    }
    const records = [
      {
        task: childTask,
        reports: [
          stat(child, content.length),
          ...(mode === "depth"
            ? []
            : [hash(mode === "hash" ? "a".repeat(64) : childHash)]),
        ],
        subtasks: [],
      },
      {
        task: task(input, 0, ""),
        reports: [
          stat(input, bytes.length),
          hash(sha256),
          ...(mode === "multi-file-failure" || mode === "multi-file-dependency"
            ? [
                {
                  __typename__: "MultiFileReport",
                  id: mode === "multi-file-dependency" ? "sq-id" : "mf-id",
                  handler_name:
                    mode === "multi-file-dependency" ? "squashfs" : "tar",
                  name:
                    mode === "multi-file-dependency"
                      ? "rootfs.squashfs"
                      : "rootfs.tar",
                  paths: [
                    join(
                      output,
                      mode === "multi-file-dependency"
                        ? "rootfs.squashfs"
                        : "rootfs.tar",
                    ),
                  ],
                  extraction_reports: [
                    mode === "multi-file-dependency"
                      ? {
                          __typename__: "ExtractorDependencyNotFoundReport",
                          severity: "ERROR",
                          dependencies: ["sasquatch"],
                        }
                      : {
                          __typename__: "ExtractorExecutionErrorReport",
                          severity: "ERROR",
                          handler: "tar",
                        },
                  ],
                },
              ]
            : []),
          {
            __typename__: "ChunkReport",
            id: "gzip-id",
            start_offset: 0,
            end_offset: bytes.length,
            size: bytes.length,
            handler_name: "gzip",
            is_encrypted: false,
            extraction_reports:
              mode === "dependency" || mode === "unnamed-chunk-dependency"
                ? [
                    {
                      __typename__: "ExtractorDependencyNotFoundReport",
                      severity: "ERROR",
                      dependencies:
                        mode === "unnamed-chunk-dependency"
                          ? []
                          : ["sasquatch"],
                    },
                  ]
                : [],
          },
        ],
        subtasks: [childTask],
      },
    ];
    if (mode === "many-unknown") {
      records[1].reports = [
        ...records[1].reports,
        ...Array.from({ length: 1000 }, (_, index) => ({
          __typename__: "UnknownChunkReport",
          id: `unknown-${index}`,
          start_offset: 0,
          end_offset: 1,
          size: 1,
        })),
      ];
    }
    if (mode === "unnamed-dependency") {
      records[1].reports = [
        ...records[1].reports,
        {
          __typename__: "ExtractorDependencyNotFoundReport",
          severity: "ERROR",
          dependencies: [],
        },
      ];
    }
    if (
      mode !== "depth-reentry" &&
      mode !== "depth-orphan" &&
      mode !== "nested-unknown" &&
      mode !== "nested-unknown-oversized"
    )
      await writeFile(
        reportPath,
        mode === "malformed" || mode === "workspace-cleanup-failure-malformed"
          ? "["
          : JSON.stringify(records),
      );
    if (mode === "dependency" || mode === "multi-file-dependency")
      process.exitCode = 1;
    if (
      mode === "workspace-cleanup-failure" ||
      mode === "workspace-cleanup-failure-malformed"
    ) {
      const blocked = join(process.cwd(), "cleanup-blocked");
      await mkdir(blocked);
      await writeFile(join(blocked, "retained"), "owned workspace bytes");
      await chmod(blocked, 0);
    }
  }
}
