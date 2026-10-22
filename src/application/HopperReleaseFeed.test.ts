import { describe, expect, it } from "vitest";

import { parseLinuxHopperReleases } from "./HopperReleaseFeed.js";

const release = {
  version: "99.2.1",
  filename:
    "https://www.hopperapp.com:443/downloader/public/Hopper-99.2.1-Linux-demo.deb",
  file_length: "123",
  file_hash: "a".repeat(40),
  main_exe_hash: "b".repeat(64),
  signature: "AQ==",
  public: "1",
  beta: "0",
  published_at: "preserved vendor field",
};

describe("Linux Hopper release feed boundary", () => {
  it("preserves future release identity and partial platform facts", () => {
    const parsed = parseLinuxHopperReleases({
      "Ubuntu / Mint": release,
      "OS X": { signature: "Sparkle DSA" },
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        deb: { ok: true, value: release },
        rpm: { ok: false },
        arch: { ok: false },
      },
    });
    if (!parsed.ok || !parsed.value.deb.ok) throw new Error("Missing release");
    expect(parsed.value.deb.value.filename).toBe(release.filename);
  });

  it.each([
    { signature: undefined },
    { signature: "AQ==garbage" },
    { main_exe_hash: "b".repeat(40) },
    { file_length: "100000001" },
    { file_length: "NaN" },
    { public: "0" },
    { beta: "1" },
    {
      filename:
        "https://other.example/downloader/public/Hopper-99.2.1-Linux-demo.deb",
    },
    { filename: release.filename + "?token=caller" },
    {
      filename: release.filename.replace("https://", "https://user:password@"),
    },
    { filename: release.filename.replace(".deb", ".rpm") },
    { filename: release.filename.replace("demo.deb", "full.deb") },
  ])(
    "rejects metadata outside the selected public package contract: %j",
    (changes) => {
      expect(
        parseLinuxHopperReleases({
          "Ubuntu / Mint": { ...release, ...changes },
        }),
      ).toMatchObject({
        ok: true,
        value: { deb: { ok: false, error: { reason: "release_metadata" } } },
      });
    },
  );

  it.each([null, [], "html error page"])(
    "keeps malformed feed roots unknown",
    (raw) => {
      expect(parseLinuxHopperReleases(raw)).toMatchObject({
        ok: false,
        error: { reason: "release_metadata" },
      });
    },
  );
});
