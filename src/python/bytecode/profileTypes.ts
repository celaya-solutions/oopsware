/** What one CPython release reports about its own bytecode (scripts/python/bytecode-profile.py). */
export interface BytecodeProfileData {
  /** Feature release, e.g. "3.13". */
  readonly version: string;
  /** Exact interpreter release the tables were read from, e.g. "3.13.16". */
  readonly release: string;
  /** First two bytes of importlib.util.MAGIC_NUMBER, little-endian. */
  readonly magic: number;
  readonly marshal_version: number;
  /** Base (unspecialized) instruction names and their byte values. */
  readonly opcodes: Readonly<Record<string, number>>;
  readonly has_argument: number;
  /** Opcodes that take an argument (3.12+); older releases use has_argument. */
  readonly hasarg: readonly number[] | null;
  /** Inline cache code units after an instruction (3.11+). */
  readonly cache: Readonly<Record<string, number>>;
  readonly sets: Readonly<Record<string, readonly number[]>>;
  readonly cmp_op: readonly string[];
  readonly nb_ops: readonly string[];
  readonly intrinsic_1: readonly string[] | null;
  readonly intrinsic_2: readonly string[] | null;
  readonly common_constants: readonly string[] | null;
  readonly special_methods: readonly string[] | null;
  readonly function_attr_flags: readonly string[] | null;
  readonly make_function_flags: readonly string[] | null;
  readonly format_value_converters: readonly string[] | null;
  /** unicodedata.unidata_version of the release. */
  readonly unicode_version: string;
  /** Sorted [start, end) code point ranges that release's str.isprintable accepts. */
  readonly printable: readonly (readonly [number, number])[];
  /** Code object flag bit -> name, as dis.COMPILER_FLAG_NAMES. */
  readonly code_flags: Readonly<Record<string, string>>;
}
