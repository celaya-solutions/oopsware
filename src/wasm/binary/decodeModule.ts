import { ByteReader, WasmDecodeError } from "./ByteReader.js";
import {
  SECTION_NAMES,
  WASM_MAGIC,
  type DecodedModule,
  type Section,
} from "./moduleTypes.js";
import { decodeNames, decodeProducers, SECTION_DECODERS } from "./sections.js";

/**
 * Structural decoder of one WebAssembly core module. It walks every section
 * boundary, decodes the sections of the supported profile, and keeps going
 * past a malformed or unsupported section whose length is still known, so one
 * bad section does not erase the facts of the others. Nothing is
 * instantiated, imported or executed.
 */

/** Required relative order of non-custom sections (tag sits between memory and global). */
const SECTION_ORDER = [1, 2, 3, 4, 5, 13, 6, 7, 8, 9, 12, 10, 11];

const emptyModule = (
  kind: DecodedModule["kind"],
  version: number | null,
): DecodedModule => ({
  kind,
  version,
  sections: [],
  types: [],
  imports: [],
  functionTypes: [],
  tables: [],
  memories: [],
  globals: [],
  exports: [],
  start: null,
  elements: [],
  data: [],
  dataCount: null,
  bodies: [],
  names: { module: null, functions: new Map(), locals: new Map() },
  producers: [],
  proposals: new Set(),
  diagnostics: [],
  incompleteSections: new Set(),
  importedFunctions: 0,
});

/** Check a non-custom section's place in the required order. */
const checkOrder = (
  module: DecodedModule,
  section: Section,
  order: { last: number; readonly seen: Set<number> },
): void => {
  const position = SECTION_ORDER.indexOf(section.id);
  const problem = order.seen.has(section.id)
    ? `Duplicate ${section.name} section.`
    : position < order.last
      ? `The ${section.name} section is out of order.`
      : null;
  if (problem !== null)
    module.diagnostics.push({
      offset: section.offset,
      message: problem,
      section: section.name,
      proposal: null,
    });
  order.seen.add(section.id);
  order.last = Math.max(order.last, position);
};

/**
 * Decode one section inside its own range. A failure is recorded as a
 * diagnostic on that section only; the caller continues at the next boundary.
 */
const decodeSection = (
  module: DecodedModule,
  reader: ByteReader,
  section: Section & { customName: string | null; decoded: boolean },
  order: { last: number; readonly seen: Set<number> },
): void => {
  try {
    if (section.id === 0) {
      section.customName = reader.name("custom section name");
      if (section.customName === "name") decodeNames(reader, module);
      else if (section.customName === "producers")
        decodeProducers(reader, module);
      return;
    }
    if (section.id === 13)
      throw new WasmDecodeError(
        section.offset,
        "The tag section belongs to the exception-handling proposal, which this reader does not decode.",
        "exception-handling",
      );
    const decoder = SECTION_DECODERS[section.id];
    if (decoder === undefined)
      throw new WasmDecodeError(
        section.offset,
        `Unknown section id ${String(section.id)}.`,
      );
    checkOrder(module, section, order);
    decoder(reader, module);
    if (!reader.atEnd())
      throw new WasmDecodeError(
        reader.offset,
        `The ${section.name} section has ${String(reader.remaining)} unread trailing bytes.`,
      );
  } catch (cause) {
    if (!(cause instanceof WasmDecodeError)) throw cause;
    if (cause.proposal !== null) module.proposals.add(cause.proposal);
    section.decoded = false;
    if (section.id !== 0) module.incompleteSections.add(section.id);
    module.diagnostics.push({
      offset: cause.offset,
      message: cause.message,
      section:
        section.customName === null
          ? section.name
          : `custom:${section.customName}`,
      proposal: cause.proposal,
    });
  }
};

/** Decode header and sections. A component or unknown header stops after the preamble. */
export const decodeModule = (bytes: Uint8Array): DecodedModule => {
  if (
    bytes.length < 8 ||
    WASM_MAGIC.some((value, index) => bytes[index] !== value)
  ) {
    const module = emptyModule("unknown", null);
    module.diagnostics.push({
      offset: 0,
      message:
        bytes.length < 8
          ? "File is shorter than the 8-byte WebAssembly preamble."
          : "File does not start with the WebAssembly magic bytes \\0asm.",
      section: null,
      proposal: null,
    });
    return module;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const layer = view.getUint16(6, true);
  if (version === 1 && layer === 0) {
    // Core module; continue below.
  } else if (layer === 1) {
    const module = emptyModule("component", version);
    module.proposals.add("component-model");
    module.diagnostics.push({
      offset: 4,
      message: `Component-model binary (version 0x${version.toString(16)}, layer 1); this reader decodes core modules only.`,
      section: null,
      proposal: "component-model",
    });
    return module;
  } else {
    const module = emptyModule("unknown", version);
    module.diagnostics.push({
      offset: 4,
      message: `Unknown WebAssembly version ${String(version)}, layer ${String(layer)}.`,
      section: null,
      proposal: null,
    });
    return module;
  }

  const module = emptyModule("module", 1);
  const reader = new ByteReader(bytes, 8, bytes.length);
  const order = { last: -1, seen: new Set<number>() };
  while (!reader.atEnd()) {
    const offset = reader.offset;
    let id: number;
    let size: number;
    try {
      id = reader.u8("section id");
      size = reader.count("section byte");
    } catch (cause) {
      // Without a trustworthy length no later section boundary is known.
      const error = cause instanceof WasmDecodeError ? cause : null;
      module.diagnostics.push({
        offset: error?.offset ?? offset,
        message: `${error?.message ?? "Section header could not be read."} Decoding stopped; later bytes were not examined.`,
        section: null,
        proposal: null,
      });
      module.incompleteSections.add(-1);
      break;
    }
    const payloadOffset = reader.offset;
    const end = payloadOffset + size;
    const section = {
      id,
      name: SECTION_NAMES[id] ?? `unknown-${String(id)}`,
      offset,
      payloadOffset,
      size,
      customName: null as string | null,
      decoded: true,
    };
    decodeSection(
      module,
      new ByteReader(bytes, payloadOffset, end),
      section,
      order,
    );
    module.sections.push(section);
    reader.skipTo(end);
  }
  if (
    module.functionTypes.length !== module.bodies.length &&
    !module.incompleteSections.has(3) &&
    !module.incompleteSections.has(10)
  )
    module.diagnostics.push({
      offset: 8,
      message: `The function section declares ${String(module.functionTypes.length)} functions but the code section has ${String(module.bodies.length)} bodies.`,
      section: "code",
      proposal: null,
    });
  return module;
};
