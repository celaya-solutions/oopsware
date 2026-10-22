/** Supported native resource receivers, shared by acquisition and validity owners. */
export const BUILTIN_RESOURCE_METHODS = {
  fs: ["open", "openSync", "createReadStream", "createWriteStream"],
  "fs/promises": ["open"],
  net: ["connect", "createConnection"],
  tls: ["connect", "createConnection"],
} as const;

export const BUILTIN_RESOURCE_SPECIFIERS = Object.keys(
  BUILTIN_RESOURCE_METHODS,
);
