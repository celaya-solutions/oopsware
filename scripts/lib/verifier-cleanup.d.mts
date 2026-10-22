/** Attempt every owned cleanup and retain the primary verification failure. */
export function closeVerifierResources(
  tasks: readonly (() => void | Promise<void>)[],
  primaryError?: unknown,
): Promise<void>;
