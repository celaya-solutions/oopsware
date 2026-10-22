/** ggml da8e2a54: enum ggml_type and block sizeof assertions in ggml-common.h.
 * Unknown future IDs retain their numeric identity and an unknown byte length.
 */
const GGML_TYPES: Readonly<Record<number, readonly [string, number, number]>> =
  {
    0: ["F32", 1, 4],
    1: ["F16", 1, 2],
    2: ["Q4_0", 32, 18],
    3: ["Q4_1", 32, 20],
    6: ["Q5_0", 32, 22],
    7: ["Q5_1", 32, 24],
    8: ["Q8_0", 32, 34],
    9: ["Q8_1", 32, 36],
    10: ["Q2_K", 256, 84],
    11: ["Q3_K", 256, 110],
    12: ["Q4_K", 256, 144],
    13: ["Q5_K", 256, 176],
    14: ["Q6_K", 256, 210],
    15: ["Q8_K", 256, 292],
    16: ["IQ2_XXS", 256, 66],
    17: ["IQ2_XS", 256, 74],
    18: ["IQ3_XXS", 256, 98],
    19: ["IQ1_S", 256, 50],
    20: ["IQ4_NL", 32, 18],
    21: ["IQ3_S", 256, 110],
    22: ["IQ2_S", 256, 82],
    23: ["IQ4_XS", 256, 136],
    24: ["I8", 1, 1],
    25: ["I16", 1, 2],
    26: ["I32", 1, 4],
    27: ["I64", 1, 8],
    28: ["F64", 1, 8],
    29: ["IQ1_M", 256, 56],
    30: ["BF16", 1, 2],
    34: ["TQ1_0", 256, 54],
    35: ["TQ2_0", 256, 66],
    39: ["MXFP4", 32, 17],
    40: ["NVFP4", 64, 36],
    41: ["Q1_0", 128, 18],
    42: ["Q2_0", 64, 18],
  };

export const ggmlType = (
  id: number,
): readonly [string, number, number] | undefined => GGML_TYPES[id];

/** safetensors e246a256 Dtype::bitsize, including packed sub-byte types. */
const SAFETENSORS_BITS: Readonly<Record<string, number>> = {
  BOOL: 8,
  F4: 4,
  F6_E2M3: 6,
  F6_E3M2: 6,
  I8: 8,
  U8: 8,
  F8_E5M2: 8,
  F8_E4M3: 8,
  F8_E8M0: 8,
  F8_E4M3FNUZ: 8,
  F8_E5M2FNUZ: 8,
  I16: 16,
  U16: 16,
  F16: 16,
  BF16: 16,
  I32: 32,
  U32: 32,
  F32: 32,
  I64: 64,
  U64: 64,
  F64: 64,
  C64: 64,
};

export const safetensorsBits = (type: string): number | undefined =>
  Object.hasOwn(SAFETENSORS_BITS, type) ? SAFETENSORS_BITS[type] : undefined;
