/** DWARF 5 section 7 constants this reader uses; names follow the standard. */

export const DW_TAG = {
  array_type: 0x01,
  class_type: 0x02,
  enumeration_type: 0x04,
  formal_parameter: 0x05,
  label: 0x0a,
  lexical_block: 0x0b,
  member: 0x0d,
  pointer_type: 0x0f,
  reference_type: 0x10,
  compile_unit: 0x11,
  structure_type: 0x13,
  subroutine_type: 0x15,
  typedef: 0x16,
  union_type: 0x17,
  inlined_subroutine: 0x1d,
  base_type: 0x24,
  const_type: 0x26,
  subprogram: 0x2e,
  variable: 0x34,
  volatile_type: 0x35,
  restrict_type: 0x37,
  namespace: 0x39,
  unspecified_type: 0x3b,
  partial_unit: 0x3c,
  type_unit: 0x41,
  rvalue_reference_type: 0x42,
  atomic_type: 0x47,
  call_site: 0x48,
  skeleton_unit: 0x4a,
  GNU_call_site: 0x4109,
} as const;

export const TYPE_TAGS: ReadonlySet<number> = new Set([
  DW_TAG.array_type,
  DW_TAG.class_type,
  DW_TAG.enumeration_type,
  DW_TAG.pointer_type,
  DW_TAG.reference_type,
  DW_TAG.structure_type,
  DW_TAG.subroutine_type,
  DW_TAG.typedef,
  DW_TAG.union_type,
  DW_TAG.base_type,
  DW_TAG.const_type,
  DW_TAG.volatile_type,
  DW_TAG.restrict_type,
  DW_TAG.unspecified_type,
  DW_TAG.rvalue_reference_type,
  DW_TAG.atomic_type,
]);

export const DW_AT = {
  sibling: 0x01,
  location: 0x02,
  name: 0x03,
  byte_size: 0x0b,
  stmt_list: 0x10,
  low_pc: 0x11,
  high_pc: 0x12,
  language: 0x13,
  comp_dir: 0x1b,
  inline: 0x20,
  producer: 0x25,
  abstract_origin: 0x31,
  decl_column: 0x39,
  decl_file: 0x3a,
  decl_line: 0x3b,
  declaration: 0x3c,
  external: 0x3f,
  specification: 0x47,
  ranges: 0x55,
  linkage_name: 0x6e,
  str_offsets_base: 0x72,
  addr_base: 0x73,
  rnglists_base: 0x74,
  dwo_name: 0x76,
  loclists_base: 0x8c,
  MIPS_linkage_name: 0x2007,
  GNU_dwo_name: 0x2130,
  GNU_dwo_id: 0x2131,
  GNU_ranges_base: 0x2132,
  GNU_addr_base: 0x2133,
} as const;

export const DW_FORM = {
  addr: 0x01,
  block2: 0x03,
  block4: 0x04,
  data2: 0x05,
  data4: 0x06,
  data8: 0x07,
  string: 0x08,
  block: 0x09,
  block1: 0x0a,
  data1: 0x0b,
  flag: 0x0c,
  sdata: 0x0d,
  strp: 0x0e,
  udata: 0x0f,
  ref_addr: 0x10,
  ref1: 0x11,
  ref2: 0x12,
  ref4: 0x13,
  ref8: 0x14,
  ref_udata: 0x15,
  indirect: 0x16,
  sec_offset: 0x17,
  exprloc: 0x18,
  flag_present: 0x19,
  strx: 0x1a,
  addrx: 0x1b,
  ref_sup4: 0x1c,
  strp_sup: 0x1d,
  data16: 0x1e,
  line_strp: 0x1f,
  ref_sig8: 0x20,
  implicit_const: 0x21,
  loclistx: 0x22,
  rnglistx: 0x23,
  ref_sup8: 0x24,
  strx1: 0x25,
  strx2: 0x26,
  strx3: 0x27,
  strx4: 0x28,
  addrx1: 0x29,
  addrx2: 0x2a,
  addrx3: 0x2b,
  addrx4: 0x2c,
  GNU_addr_index: 0x1f01,
  GNU_str_index: 0x1f02,
  GNU_ref_alt: 0x1f20,
  GNU_strp_alt: 0x1f21,
} as const;

/** DWARF 5 table 7.2 unit types. */
export const UNIT_TYPES: Readonly<Record<number, string>> = {
  1: "compile",
  2: "type",
  3: "partial",
  4: "skeleton",
  5: "split_compile",
  6: "split_type",
};

export const LANGUAGES: Readonly<Record<number, string>> = {
  0x01: "C89",
  0x02: "C",
  0x03: "Ada83",
  0x04: "C++",
  0x05: "Cobol74",
  0x06: "Cobol85",
  0x07: "Fortran77",
  0x08: "Fortran90",
  0x09: "Pascal83",
  0x0a: "Modula2",
  0x0b: "Java",
  0x0c: "C99",
  0x0d: "Ada95",
  0x0e: "Fortran95",
  0x0f: "PLI",
  0x10: "ObjC",
  0x11: "ObjC++",
  0x12: "UPC",
  0x13: "D",
  0x14: "Python",
  0x15: "OpenCL",
  0x16: "Go",
  0x17: "Modula3",
  0x18: "Haskell",
  0x19: "C++03",
  0x1a: "C++11",
  0x1b: "OCaml",
  0x1c: "Rust",
  0x1d: "C11",
  0x1e: "Swift",
  0x1f: "Julia",
  0x20: "Dylan",
  0x21: "C++14",
  0x22: "Fortran03",
  0x23: "Fortran08",
  0x24: "RenderScript",
  0x25: "BLISS",
  0x8001: "Mips_Assembler",
};

export const isStringIndexForm = (form: number): boolean =>
  form === DW_FORM.strx ||
  form === DW_FORM.strx1 ||
  form === DW_FORM.strx2 ||
  form === DW_FORM.strx3 ||
  form === DW_FORM.strx4 ||
  form === DW_FORM.GNU_str_index;

export const isAddressIndexForm = (form: number): boolean =>
  form === DW_FORM.addrx ||
  form === DW_FORM.addrx1 ||
  form === DW_FORM.addrx2 ||
  form === DW_FORM.addrx3 ||
  form === DW_FORM.addrx4 ||
  form === DW_FORM.GNU_addr_index;

export const isReferenceForm = (form: number): boolean =>
  form === DW_FORM.ref1 ||
  form === DW_FORM.ref2 ||
  form === DW_FORM.ref4 ||
  form === DW_FORM.ref8 ||
  form === DW_FORM.ref_udata ||
  form === DW_FORM.ref_addr;
