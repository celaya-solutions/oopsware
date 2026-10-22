/** Attempt every owned cleanup and retain the primary verification failure. */
export async function closeVerifierResources(tasks, primaryError) {
  const failures = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (cause) {
      failures.push(cause);
    }
  }

  if (failures.length > 0)
    throw new AggregateError(
      primaryError === undefined ? failures : [primaryError, ...failures],
      "Verifier cleanup failed",
    );
}
