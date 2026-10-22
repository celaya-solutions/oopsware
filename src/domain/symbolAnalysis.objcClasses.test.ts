import { describe, expect, it } from "vitest";

import { discoverObjcClasses } from "./symbolAnalysis.js";

describe("Objective-C class label discovery", () => {
  it("does not reinterpret a provider-specific label without an owner tag", () => {
    expect(
      discoverObjcClasses(
        [{ address: "0x1", name: "__objc_class_HuntRoot_class" }],
        "Hunt",
      ),
    ).toEqual({ count: 0, classes: [] });
  });

  it("uses provider-tagged stripped class labels and filters their exact text", () => {
    const labels = [
      "__objc_class_HuntRoot_class",
      "__objc_class_HuntSub_class",
      "__objc_class_HuntWorker_class",
      "__objc_class_HuntModel_class",
      "__objc_class_HuntLegacy_class",
      "__objc_class_Hunt_class_class",
      "prefix__objc_class_HuntForeign_class",
      "__objc_class__class",
      "__objc_class_HuntMissingSuffix",
      "__objc_class_HuntExtra_class_suffix",
    ];
    const names = labels.map((name, index) => ({
      address: `0x${(index + 1).toString(16)}`,
      name,
      ...(index < 6
        ? { objc_class_label: "hopper_legacy_class_object" as const }
        : {}),
    }));

    expect(discoverObjcClasses(names, "Hunt")).toEqual({
      count: 6,
      classes: names.slice(0, 6).map(({ address, name }) => ({
        address,
        name,
      })),
    });
    expect(discoverObjcClasses(names, "__objc_class_HuntRoot_class")).toEqual({
      count: 1,
      classes: [{ address: "0x1", name: "__objc_class_HuntRoot_class" }],
    });
  });
});
