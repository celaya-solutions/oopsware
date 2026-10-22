/** Effective UID parsed from one Linux `/proc/<pid>/status` record. */
export const parseLinuxProcessEffectiveUid = (
  value: string,
): number | undefined => {
  let effectiveUid: number | undefined;
  for (const line of value.split("\n")) {
    if (!line.startsWith("Uid:")) continue;
    if (effectiveUid !== undefined) return undefined;
    const match = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/u.exec(
      line,
    );
    if (match === null) return undefined;
    const values = match.slice(1).map(Number);
    if (values.some((uid) => !Number.isSafeInteger(uid) || uid < 0))
      return undefined;
    effectiveUid = values[1];
  }
  return effectiveUid;
};
