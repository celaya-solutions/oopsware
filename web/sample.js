// Oopsware sample artifact: inspect this file, browse its bytes, or ask a local model about it.
// This is static example code. Oopsware never executes it during inspection.
const API_BASE = "https://example.invalid/v1";
const CLIENT_VERSION = "1.0.0";

export function requestUrl(resource) {
  if (!/^[a-z-]+$/.test(resource)) throw new Error("Invalid resource");
  return `${API_BASE}/${resource}?client=${CLIENT_VERSION}`;
}

export function decodeMessage(encoded) {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}
