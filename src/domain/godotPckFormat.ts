/** "GDPC" read as a little-endian uint32: the Godot Engine pack magic. */
export const GODOT_PCK_MAGIC = 0x43504447;

/** Whether bytes start with a standalone Godot PCK header. */
export const hasGodotPckHeader = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x47 &&
  bytes[1] === 0x44 &&
  bytes[2] === 0x50 &&
  bytes[3] === 0x43;
