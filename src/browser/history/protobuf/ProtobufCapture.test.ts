import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../artifacts/ArtifactResourceScope.js";
import {
  inspectWebNetworkCaptureInputSchema,
  type WebNetworkCapture,
} from "../../../domain/webNetworkCapture.js";
import {
  prepareCaptureProtobuf,
  decodeCaptureProtobuf,
} from "./ProtobufCapture.js";

const binary = (pointer: string, bytes: Buffer) => ({
  pointer,
  representation: "producer-bytes" as const,
  state: "retained" as const,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  content_base64: bytes.toString("base64"),
});

const captureWithBody = (
  contentType: string,
  body: Buffer,
): WebNetworkCapture => ({
  artifact: { path: "/fixture.mitm", bytes: 100, sha256: "a".repeat(64) },
  decoder: { id: "fixture", name: "Native producer facts", version: "1" },
  container: {
    reported: null,
    numeric_literals: [],
    redactions: [],
    records_pointer: "/flows",
  },
  format: "mitmproxy",
  total_records: 1,
  runtime_attribution: "unknown",
  limitations: [],
  records: [
    {
      ordinal: 0,
      location: { kind: "byte-range", offset: 0, bytes: 100 },
      reported: { response: { headers: [[null, null]], content: null } },
      binary_fields: [
        binary("/response/headers/0/0", Buffer.from("content-type")),
        binary("/response/headers/0/1", Buffer.from(contentType)),
        binary("/response/content", body),
      ],
      numeric_literals: [],
      redactions: [],
      limitations: [],
    },
  ],
});

const decode = async (capture: WebNetworkCapture) => {
  const input = inspectWebNetworkCaptureInputSchema.parse({
    capture_path: capture.artifact.path,
    format: capture.format,
    record_ordinals: [0],
  });
  const resources = new ArtifactResourceScope();
  try {
    const prepared = await prepareCaptureProtobuf(capture, input);
    await decodeCaptureProtobuf(capture, input, resources, prepared);
  } finally {
    await resources.close();
  }
};

const grpcWebTrailerFrame = (text: Buffer) => {
  const frame = Buffer.alloc(5 + text.length);
  frame[0] = 128;
  frame.writeUInt32BE(text.length, 1);
  text.copy(frame, 5);
  return frame;
};

it("restricts framing overrides to native body facts while preserving header bytes", async () => {
  const payload = Buffer.from([8, 1]);
  const body = Buffer.alloc(5 + payload.length);
  body.writeUInt32BE(payload.length, 1);
  payload.copy(body, 5);
  const report = captureWithBody("application/grpc", body);
  const headers = report.records[0]!.binary_fields.slice(0, 2);
  const input = inspectWebNetworkCaptureInputSchema.parse({
    capture_path: report.artifact.path,
    format: report.format,
    record_ordinals: [0],
    protobuf: { framing: "grpc" },
  });
  const resources = new ArtifactResourceScope();
  try {
    const prepared = await prepareCaptureProtobuf(report, input);
    await decodeCaptureProtobuf(report, input, resources, prepared);
  } finally {
    await resources.close();
  }
  expect(report.records[0]?.protobuf).toMatchObject([
    {
      pointer: "/response/content",
      status: "complete",
      fields: [{ number: 1, value: "1" }],
    },
  ]);
  expect(report.records[0]?.protobuf).toHaveLength(1);
  expect(report.records[0]?.binary_fields.slice(0, 2)).toEqual(headers);
  expect(report.protobuf_coverage?.status).toBe("complete");
});

it("keeps capture coverage partial for a malformed gRPC-web trailer", async () => {
  const trailerText = Buffer.from("grpc-status: 0\u0000bad\r\n");
  const body = grpcWebTrailerFrame(trailerText);
  const report = captureWithBody("application/grpc-web", body);
  const retainedBody = report.records[0]!.binary_fields[2];
  await decode(report);

  expect(report.records[0]?.protobuf?.[0]).toMatchObject({
    framing: "grpc-web",
    status: "partial",
    examined_bytes: body.length,
    frames: [{ status: "partial", examined_bytes: trailerText.length }],
  });
  expect(report.protobuf_coverage?.status).toBe("partial");
  expect(report.records[0]?.binary_fields[2]).toEqual(retainedBody);
});
