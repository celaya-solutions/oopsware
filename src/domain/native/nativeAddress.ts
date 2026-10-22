import { z } from "zod";

/** Canonical hexadecimal coordinate, retaining its optional address space. */
export const nativeAddressSchema = z
  .string()
  .regex(
    /^(?:(?:[A-Za-z0-9._~\x2d]|%[0-9A-F]{2})+:)?0x(?:0|[1-9a-f][0-9a-f]*)$/u,
  );

/** Accept equivalent hexadecimal spellings without changing address-space identity. */
export const nativeAddressInputSchema = z
  .string()
  .regex(/^(?:(?:[A-Za-z0-9._~\x2d]|%[0-9a-fA-F]{2})+:)?0[xX][0-9a-fA-F]+$/u)
  .transform((address) => {
    const separator = address.lastIndexOf(":") + 1;
    const space = address
      .slice(0, separator)
      .replace(/%[0-9a-fA-F]{2}/gu, (escape) => escape.toUpperCase());
    return `${space}0x${BigInt(address.slice(separator)).toString(16)}`;
  });

export const parseNativeAddress = (input: unknown): string =>
  nativeAddressInputSchema.parse(input);
