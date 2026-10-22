const PRIMITIVES: Readonly<Record<string, string>> = {
  B: "byte",
  C: "char",
  D: "double",
  F: "float",
  I: "int",
  J: "long",
  S: "short",
  Z: "boolean",
  V: "void",
};

/** `java/lang/String` → `java.lang.String`; nested-class `$` is kept as written. */
export const binaryName = (internal: string): string =>
  internal.replaceAll("/", ".");

/** Read one field type at `start`; null when the descriptor is malformed. */
const fieldType = (
  descriptor: string,
  start: number,
  allowVoid: boolean,
): { text: string; end: number } | null => {
  let dimensions = 0;
  let index = start;
  while (descriptor[index] === "[") {
    dimensions += 1;
    index += 1;
  }
  if (dimensions > 255) return null;
  const code = descriptor[index];
  let text: string;
  if (code === "L") {
    const close = descriptor.indexOf(";", index);
    if (close <= index + 1) return null;
    const name = descriptor.slice(index + 1, close);
    if (/[.[;]/u.test(name)) return null;
    text = binaryName(name);
    index = close + 1;
  } else {
    const primitive = code === undefined ? undefined : PRIMITIVES[code];
    if (primitive === undefined) return null;
    if (code === "V" && (!allowVoid || dimensions > 0)) return null;
    text = primitive;
    index += 1;
  }
  return { text: text + "[]".repeat(dimensions), end: index };
};

/** `[Ljava/lang/String;` → `java.lang.String[]`, or null when malformed. */
export const fieldTypeText = (descriptor: string): string | null => {
  const read = fieldType(descriptor, 0, false);
  return read !== null && read.end === descriptor.length ? read.text : null;
};

export interface MethodTypeText {
  readonly parameters: readonly string[];
  readonly returns: string;
}

/** `(ILjava/lang/String;)V` → parameters and return type, or null when malformed. */
export const methodTypeText = (descriptor: string): MethodTypeText | null => {
  if (descriptor[0] !== "(") return null;
  const parameters: string[] = [];
  let index = 1;
  while (descriptor[index] !== ")") {
    if (index >= descriptor.length) return null;
    const read = fieldType(descriptor, index, false);
    if (read === null) return null;
    parameters.push(read.text);
    index = read.end;
  }
  const result = fieldType(descriptor, index + 1, true);
  if (result === null || result.end !== descriptor.length) return null;
  return { parameters, returns: result.text };
};

/** Argument slots a method descriptor takes (long and double take two). */
export const parameterSlots = (descriptor: string): number | null => {
  const parsed = methodTypeText(descriptor);
  if (parsed === null) return null;
  return parsed.parameters.reduce(
    (slots, type) => slots + (type === "long" || type === "double" ? 2 : 1),
    0,
  );
};

/** A Java-like declaration line, e.g. `public static void main(java.lang.String[])`. */
export const methodDeclaration = (
  modifiers: readonly string[],
  owner: string | null,
  name: string,
  descriptor: string,
): string | null => {
  const type = methodTypeText(descriptor);
  if (type === null) return null;
  const prefix = modifiers.length === 0 ? "" : `${modifiers.join(" ")} `;
  const parameters = type.parameters.join(", ");
  if (name === "<clinit>") return "static {}";
  // javap prints a constructor under the class's binary name.
  if (name === "<init>" && owner !== null)
    return `${prefix}${binaryName(owner)}(${parameters})`;
  return `${prefix}${type.returns} ${name}(${parameters})`;
};
