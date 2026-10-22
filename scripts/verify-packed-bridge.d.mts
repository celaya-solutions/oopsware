/** Validate required shipped bridges and parse packed Python without extraction. */
export function verifyPackedBridge(input: {
  readonly tarball: string;
  readonly packedFiles: readonly string[];
}): Promise<void>;
