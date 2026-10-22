const VERSIONED = /^META-INF\/versions\/(\d+)\/(.+)$/u;

/** A `.class` member's place: its release and the path a JVM would look it up under. */
export const classLocation = (
  path: string,
): { release: number | null; logical: string } | null => {
  if (!path.endsWith(".class")) return null;
  const versioned = VERSIONED.exec(path);
  if (versioned !== null) {
    const release = Number(versioned[1]);
    const logical = versioned[2] ?? "";
    // JDK multi-release lookup only honours releases from 9.
    if (Number.isSafeInteger(release) && release >= 9)
      return { release, logical };
  }
  return { release: null, logical: path };
};
