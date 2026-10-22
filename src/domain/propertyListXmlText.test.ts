import { expect, it } from "vitest";

import {
  decodeXmlPlistText,
  XmlPlistTextDecodeError,
} from "./propertyListXmlText.js";

it.each([
  [
    Buffer.from('<?xml version="1.0" encoding="UTF-16"?><plist/>'),
    "encoding-mismatch",
  ],
  [
    Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><plist/>'),
    "unsupported-encoding",
  ],
  [Buffer.from([0xff, 0xfe, 0x3c]), "invalid-bytes"],
] as const)("tags XML decoding failures as %s", (bytes, reason) => {
  expect(() => decodeXmlPlistText(bytes)).toThrow(
    expect.objectContaining({
      name: "XmlPlistTextDecodeError",
      reason,
    } satisfies Partial<XmlPlistTextDecodeError>),
  );
});
