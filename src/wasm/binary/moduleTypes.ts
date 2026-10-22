/** Decoded shape of one WebAssembly core module, with exact byte offsets. */

export const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;

export const SECTION_NAMES: Readonly<Record<number, string>> = {
  0: "custom",
  1: "type",
  2: "import",
  3: "function",
  4: "table",
  5: "memory",
  6: "global",
  7: "export",
  8: "start",
  9: "element",
  10: "code",
  11: "data",
  12: "datacount",
  13: "tag",
};

export type ExternalKind = "func" | "table" | "memory" | "global" | "tag";
export const EXTERNAL_KINDS: readonly ExternalKind[] = [
  "func",
  "table",
  "memory",
  "global",
  "tag",
];

export interface Section {
  readonly id: number;
  readonly name: string;
  readonly offset: number;
  readonly payloadOffset: number;
  readonly size: number;
  readonly customName: string | null;
  /** False when decoding stopped inside this section; see diagnostics. */
  readonly decoded: boolean;
}

export interface FuncType {
  readonly params: readonly string[];
  readonly results: readonly string[];
}

export interface Limits {
  readonly min: bigint;
  readonly max: bigint | null;
  readonly shared: boolean;
  readonly memory64: boolean;
}

export interface Import {
  readonly module: string;
  readonly name: string;
  readonly kind: ExternalKind;
  /** Index within the kind's own index space. */
  readonly index: number;
  readonly type: number | null;
  readonly table: { readonly type: string; readonly limits: Limits } | null;
  readonly memory: Limits | null;
  readonly global: { readonly type: string; readonly mutable: boolean } | null;
  readonly offset: number;
}

export interface Table {
  readonly index: number;
  readonly imported: boolean;
  readonly type: string;
  readonly limits: Limits;
}

export interface Memory {
  readonly index: number;
  readonly imported: boolean;
  readonly limits: Limits;
}

export interface Global {
  readonly index: number;
  readonly imported: boolean;
  readonly type: string;
  readonly mutable: boolean;
  readonly init: string | null;
}

export interface Export {
  readonly name: string;
  readonly kind: ExternalKind;
  readonly index: number;
  readonly offset: number;
}

export interface ConstantOffset {
  readonly text: string;
  readonly value: bigint | null;
  readonly global: number | null;
}

export interface ElementSegment {
  readonly index: number;
  readonly offset: number;
  readonly mode: "active" | "passive" | "declarative";
  readonly table: number | null;
  readonly start: ConstantOffset | null;
  readonly type: string;
  /** Function index per item; null for `ref.null`, "unknown" for other expressions. */
  readonly items: readonly (number | null | "unknown")[];
}

export interface DataSegment {
  readonly index: number;
  readonly offset: number;
  readonly mode: "active" | "passive";
  readonly memory: number | null;
  readonly start: ConstantOffset | null;
  readonly payloadOffset: number;
  readonly size: number;
}

export interface FunctionBody {
  readonly index: number;
  readonly type: number;
  readonly offset: number;
  readonly size: number;
  /** First instruction byte after the local declarations. */
  readonly codeOffset: number;
  readonly end: number;
  readonly locals: readonly { readonly count: number; readonly type: string }[];
}

export interface Producer {
  readonly field: string;
  readonly values: readonly {
    readonly name: string;
    readonly version: string;
  }[];
}

export interface Diagnostic {
  readonly offset: number;
  readonly message: string;
  readonly section: string | null;
  readonly proposal: string | null;
}

export interface DecodedModule {
  readonly kind: "module" | "component" | "unknown";
  readonly version: number | null;
  readonly sections: Section[];
  readonly types: FuncType[];
  readonly imports: Import[];
  /** Type index of each defined (non-imported) function, in order. */
  readonly functionTypes: number[];
  readonly tables: Table[];
  readonly memories: Memory[];
  readonly globals: Global[];
  readonly exports: Export[];
  start: number | null;
  readonly elements: ElementSegment[];
  readonly data: DataSegment[];
  dataCount: number | null;
  readonly bodies: FunctionBody[];
  readonly names: {
    module: string | null;
    readonly functions: Map<number, string>;
    readonly locals: Map<number, Map<number, string>>;
  };
  readonly producers: Producer[];
  readonly proposals: Set<string>;
  readonly diagnostics: Diagnostic[];
  /** Non-custom section ids whose payload was not fully decoded; -1 marks an unreadable section header. */
  readonly incompleteSections: Set<number>;
  importedFunctions: number;
}

/** Largest local count a body may declare; bounds expanded local lists. */
export const MAX_FUNCTION_LOCALS = 50_000;
