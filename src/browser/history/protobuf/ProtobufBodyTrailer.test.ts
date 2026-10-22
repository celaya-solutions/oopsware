import { expect, it } from "vitest";
import { decodeProtobufBody } from "./ProtobufBody.js";
import { ProtobufBudget } from "./ProtobufWire.js";

const source = {
  pointer: "/response/content/text",
  content_type: "application/grpc-web+proto",
  body_sha256: "a".repeat(64),
};
const same = (value: string) => value;
const trailerFrame = (text: string) => {
  const payload = Buffer.from(text, "utf8");
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 128;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
};

it("rejects forbidden trailer controls while retaining valid earlier trailers", async () => {
  for (const code of [
    ...Array.from({ length: 32 }, (_, index) => index),
    127,
  ]) {
    if (code === 9) continue;
    const control = String.fromCharCode(code);
    const text = `grpc-message: kept\r\ngrpc-status: 0${control}bad\r\n`;
    const input = trailerFrame(text);
    const result = await decodeProtobufBody(
      input,
      "grpc-web",
      source,
      same,
      new ProtobufBudget(),
    );
    expect(result.status, JSON.stringify(control)).toBe("partial");
    expect(result.frames[0]?.error).toMatchObject({ offset: 5 });
    expect(result.examined_bytes).toBe(5 + Buffer.byteLength(text));
    expect(result.frames[0]).toMatchObject({
      status: "partial",
      examined_bytes: Buffer.byteLength(text),
    });
    expect(result.frames[0]?.trailers).toEqual([
      { name: "grpc-message", value: "kept" },
    ]);
    expect(input.subarray(5)).toEqual(Buffer.from(text, "utf8"));
  }
});

it("retains allowed whitespace, visible text, and valid UTF-8 obs-text", async () => {
  const text = "grpc-message: alpha\tbeta \u00e9\r\n";
  const result = await decodeProtobufBody(
    trailerFrame(text),
    "grpc-web",
    source,
    same,
    new ProtobufBudget(),
  );
  expect(result.status).toBe("complete");
  expect(result.frames[0]?.trailers).toEqual([
    { name: "grpc-message", value: "alpha\tbeta \u00e9" },
  ]);
  expect(result.examined_bytes).toBe(5 + Buffer.byteLength(text));
});

it.each(["Grpc-Status", "GRPC-STATUS"])(
  "retains a valid prefix when the trailer name %s violates gRPC-Web casing",
  async (name) => {
    const text = `grpc-message: kept\r\n${name}: 0\r\n`;
    const result = await decodeProtobufBody(
      trailerFrame(text),
      "grpc-web",
      source,
      same,
      new ProtobufBudget(),
    );
    expect(result.status).toBe("partial");
    expect(result.examined_bytes).toBe(5 + Buffer.byteLength(text));
    expect(result.frames[0]?.trailers).toEqual([
      { name: "grpc-message", value: "kept" },
    ]);
  },
);

it("leaves undecodable trailer fields unknown and preserves unexpected failures", async () => {
  const input = trailerFrame("grpc-status: 0\r\n");
  input[5] = 255;
  const malformed = await decodeProtobufBody(
    input,
    "grpc-web",
    source,
    same,
    new ProtobufBudget(),
  );
  expect(malformed.status).toBe("partial");
  expect(malformed.frames[0]?.examined_bytes).toBe(0);
  expect(malformed.frames[0]?.trailers).toBeUndefined();

  const failure = { kind: "controlled-redaction-failure" };
  await expect(
    decodeProtobufBody(
      trailerFrame("grpc-status: 0\r\n"),
      "grpc-web",
      source,
      () => {
        throw failure;
      },
      new ProtobufBudget(),
    ),
  ).rejects.toBe(failure);
});
