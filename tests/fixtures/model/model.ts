/** Source-built declarations with independent expected byte layouts; no model loader. */
export const ggufFixture = (
  options: {
    bigEndian?: boolean;
    version?: number;
    alignment?: number;
    metadata?: readonly { key: string; type: number; value: Buffer }[];
    tensors?: readonly {
      name: string;
      type: number;
      shape: readonly bigint[];
      offset: bigint;
      bytes: number;
    }[];
  } = {},
) => {
  const big = options.bigEndian ?? false;
  const alignment = options.alignment ?? 32;
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    if (big) b.writeUInt32BE(n);
    else b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n: bigint) => {
    const b = Buffer.alloc(8);
    if (big) b.writeBigUInt64BE(n);
    else b.writeBigUInt64LE(n);
    return b;
  };
  const text = (s: string) => {
    const b = Buffer.from(s);
    return Buffer.concat([u64(BigInt(b.length)), b]);
  };
  const metadata = options.metadata ?? [
    { key: "general.architecture", type: 8, value: text("llama") },
    { key: "general.name", type: 8, value: text("Tiny 🦙") },
    { key: "llama.context_length", type: 10, value: u64(2048n) },
    { key: "custom.exact", type: 10, value: u64(0xffffffffffffffffn) },
    {
      key: "tokenizer.ggml.tokens",
      type: 9,
      value: Buffer.concat([
        u32(8),
        u64(10n),
        ...Array.from({ length: 10 }, (_, n) => text(`token-${String(n)}`)),
      ]),
    },
    { key: "tokenizer.chat_template", type: 8, value: text("{{ messages }}") },
    ...(options.alignment === undefined
      ? []
      : [{ key: "general.alignment", type: 4, value: u32(alignment) }]),
  ];
  const tensors = options.tensors ?? [
    { name: "weight", type: 0, shape: [2n, 2n], offset: 0n, bytes: 16 },
    {
      name: "quant",
      type: 2,
      shape: [32n],
      offset: BigInt(Math.ceil(16 / alignment) * alignment),
      bytes: 18,
    },
  ];
  const header = Buffer.concat([
    Buffer.from("GGUF"),
    u32(options.version ?? 3),
    u64(BigInt(tensors.length)),
    u64(BigInt(metadata.length)),
    ...metadata.map((m) => Buffer.concat([text(m.key), u32(m.type), m.value])),
    ...tensors.map((t) =>
      Buffer.concat([
        text(t.name),
        u32(t.shape.length),
        ...t.shape.map(u64),
        u32(t.type),
        u64(t.offset),
      ]),
    ),
  ]);
  const dataOffset =
    tensors.length === 0
      ? header.length
      : Math.ceil(header.length / alignment) * alignment;
  const length = Math.max(
    dataOffset,
    ...tensors.map((t) => dataOffset + Number(t.offset) + t.bytes),
  );
  const bytes = Buffer.alloc(length, 0xa5);
  header.copy(bytes);
  bytes.fill(0, header.length, dataOffset);
  return { bytes, header, dataOffset, u32, u64, text };
};

export const safetensorsFixture = (
  header: string = JSON.stringify({
    __metadata__: { format: "pt", license: "Apache-2.0" },
    weight: { dtype: "F32", shape: [2, 2], data_offsets: [0, 16] },
    empty: { dtype: "F16", shape: [0, 7], data_offsets: [16, 16] },
  }),
  data: Buffer = Buffer.alloc(16, 0xa5),
) => {
  const text = Buffer.from(
    header + " ".repeat((8 - (Buffer.byteLength(header) % 8)) % 8),
  );
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(text.length));
  return {
    bytes: Buffer.concat([length, text, data]),
    header: Buffer.concat([length, text]),
    dataOffset: 8 + text.length,
  };
};
