import { fileURLToPath } from "node:url";
import { z } from "zod";
import { analyzeSubmission } from "./analysis.js";
import {
  buildDocumentView,
  DOCUMENT_VIEW_WORKER_MODE,
} from "./documentView.js";
import { buildWasmView, WASM_VIEW_WORKER_MODE } from "./wasmView.js";

const VIEW_BUILDERS = {
  [DOCUMENT_VIEW_WORKER_MODE]: buildDocumentView,
  [WASM_VIEW_WORKER_MODE]: buildWasmView,
} as const;

const mode = process.argv[2];
if (mode === DOCUMENT_VIEW_WORKER_MODE || mode === WASM_VIEW_WORKER_MODE) {
  // A child of the analysis worker: build one stored view, report it, exit.
  const [source, name, folder, sha256] = z
    .tuple([
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
      z.string().regex(/^[a-f0-9]{64}$/u),
    ])
    .parse(process.argv.slice(3));
  // An orphaned parse stops as soon as the analysis worker is gone.
  process.once("disconnect", () => process.exit(1));
  const summary = await VIEW_BUILDERS[mode](source, name, folder, sha256);
  await new Promise<void>((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error("A view worker needs an IPC channel."));
      return;
    }
    process.send(summary, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
  process.exit(0);
} else {
  const directory = z.string().min(1).parse(process.argv[2]);
  const id = z.string().uuid().parse(process.argv[3]);
  await analyzeSubmission(directory, id, fileURLToPath(import.meta.url));
}
