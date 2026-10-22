import { BYTECODE_PROFILE_DATA } from "./profileData.js";
import type { BytecodeProfileData } from "./profileTypes.js";

/**
 * Code object field order and instruction rules change between CPython
 * releases. Each admitted profile is one exact magic number whose tables were
 * read from that interpreter and whose decoding the real-producer lane
 * compared with that interpreter's own `dis`.
 */
export type CodeLayout = "3.8-3.10" | "3.11+";

/** Which dis release's argument rendering a profile follows. */
export type ArgumentRules = "3.9" | "3.11" | "3.12" | "3.13" | "3.14" | "3.15";

export interface BytecodeProfile {
  readonly data: BytecodeProfileData;
  readonly version: string;
  readonly magic: number;
  readonly layout: CodeLayout;
  readonly rules: ArgumentRules;
  readonly opname: ReadonlyMap<number, string>;
  readonly opcode: ReadonlyMap<string, number>;
  readonly cache: ReadonlyMap<number, number>;
  readonly has: (set: string, opcode: number) => boolean;
  readonly takesArgument: (opcode: number) => boolean;
}

const rulesFor = (version: string): ArgumentRules => {
  const minor = Number(version.split(".")[1]);
  if (minor <= 10) return "3.9";
  if (minor === 11) return "3.11";
  if (minor === 12) return "3.12";
  if (minor === 13) return "3.13";
  if (minor === 14) return "3.14";
  return "3.15";
};

const build = (data: BytecodeProfileData): BytecodeProfile => {
  const opname = new Map<number, string>();
  const opcode = new Map<string, number>();
  for (const [name, code] of Object.entries(data.opcodes)) {
    opname.set(code, name);
    opcode.set(name, code);
  }
  const cache = new Map<number, number>();
  for (const [name, size] of Object.entries(data.cache)) {
    const code = opcode.get(name);
    if (code !== undefined) cache.set(code, size);
  }
  const sets = new Map(
    Object.entries(data.sets).map(([key, codes]) => [key, new Set(codes)]),
  );
  const hasarg = data.hasarg === null ? null : new Set(data.hasarg);
  return {
    data,
    version: data.version,
    magic: data.magic,
    layout: Number(data.version.split(".")[1]) >= 11 ? "3.11+" : "3.8-3.10",
    rules: rulesFor(data.version),
    opname,
    opcode,
    cache,
    has: (set, code) => sets.get(set)?.has(code) === true,
    takesArgument: (code) =>
      hasarg === null ? code >= data.has_argument : hasarg.has(code),
  };
};

const ADMITTED = new Map(
  BYTECODE_PROFILE_DATA.map((data) => [data.magic, build(data)]),
);

/** The admitted profile for an exact magic number, or null. */
export const admittedProfile = (magic: number): BytecodeProfile | null =>
  ADMITTED.get(magic) ?? null;

export const admittedProfiles = (): readonly BytecodeProfile[] => [
  ...ADMITTED.values(),
];

/**
 * Final-release magic numbers of CPython releases, used only to name a
 * version this reader does not decode. Development and pre-release magic
 * numbers between them are reported as unknown.
 */
const RELEASE_MAGIC: ReadonlyMap<number, string> = new Map([
  [62211, "2.7"],
  [3350, "3.5"],
  [3351, "3.5"],
  [3379, "3.6"],
  [3394, "3.7"],
  [3413, "3.8"],
  [3425, "3.9"],
  [3439, "3.10"],
  [3495, "3.11"],
  [3531, "3.12"],
  [3571, "3.13"],
  [3627, "3.14"],
  [3666, "3.15"],
]);

/** The Python release a magic number belongs to, when it is a final-release magic. */
export const releaseForMagic = (magic: number): string | null =>
  admittedProfile(magic)?.version ?? RELEASE_MAGIC.get(magic) ?? null;
