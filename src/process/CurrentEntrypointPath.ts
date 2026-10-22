import { resolve } from "node:path";

/** Node's absolute argv script selection, or undefined when none was supplied.
 * Native executable paths have different traversal semantics and must not use this.
 */
export const normalizeEntrypointPath = (
  entrypoint: string | undefined,
): string | undefined =>
  entrypoint === undefined || entrypoint.length === 0
    ? undefined
    : resolve(entrypoint);

export const CURRENT_ENTRYPOINT_PATH = normalizeEntrypointPath(process.argv[1]);
