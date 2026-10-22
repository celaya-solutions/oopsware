import { ProtobufFormatError, ProtobufMessage } from "../protobuf.js";
import {
  AndroidXmlFormatError,
  MAX_XML_DEPTH,
  MAX_XML_NODES,
  RES_VALUE,
  hex8,
  resValue,
  type AndroidXmlAttribute,
  type AndroidXmlDocument,
  type AndroidXmlElement,
  type AndroidXmlNode,
  type AndroidXmlProblem,
  type AndroidXmlValue,
} from "./androidXml.js";

/**
 * aapt2's protobuf XML (Resources.proto `XmlNode`), as bundles store
 * manifests and compiled XML. Field numbers come from bundletool's copy of
 * Resources.proto; typed values come from each attribute's `compiled_item`.
 */

const FILE_TYPES: Readonly<Record<number, string>> = {
  1: " type=PNG",
  2: " type=XML",
  3: " type=protoXML",
};

const floatBits = (value: number | null): number => value ?? 0;

/** Primitive (Resources.proto): its oneof member as a Res_value. */
const primitive = (message: ProtobufMessage): AndroidXmlValue => {
  const set = (dataType: number, data: number): AndroidXmlValue =>
    resValue(dataType, data, () => null);
  if (message.has(1)) return set(RES_VALUE.null, 0);
  if (message.has(2)) return set(RES_VALUE.null, 1);
  if (message.has(3))
    return set(RES_VALUE.float, floatBits(message.fixed32(3)));
  if (message.has(13)) return set(RES_VALUE.dimension, message.uint32(13));
  if (message.has(14)) return set(RES_VALUE.fraction, message.uint32(14));
  if (message.has(6)) return set(RES_VALUE.intDec, message.int32(6));
  if (message.has(7)) return set(RES_VALUE.intHex, message.uint32(7));
  if (message.has(8))
    return set(RES_VALUE.boolean, message.bool(8) ? 0xffff_ffff : 0);
  for (const [field, dataType] of [
    [9, 0x1c],
    [10, 0x1d],
    [11, 0x1e],
    [12, 0x1f],
  ] as const)
    if (message.has(field)) return set(dataType, message.uint32(field));
  // Deprecated float members: aapt2 copies the float bits into the complex data.
  if (message.has(4))
    return set(RES_VALUE.dimension, floatBits(message.fixed32(4)));
  if (message.has(5))
    return set(RES_VALUE.fraction, floatBits(message.fixed32(5)));
  return set(RES_VALUE.null, 0);
};

/** Reference (Resources.proto): named when aapt2 recorded the name. */
const reference = (message: ProtobufMessage): AndroidXmlValue => {
  const attribute = message.uint32(1) === 1;
  const dynamic = message.message(5)?.bool(1) ?? false;
  const id = message.uint32(2);
  const name = message.string(3);
  const type = `${dynamic ? "dynamic-" : ""}${attribute ? "attribute" : "reference"}`;
  const prefix = attribute ? "?" : "@";
  if (name === "" && id === 0) return { type, data: 0, text: "@null" };
  const target =
    name === "" ? hex8(id) : `${message.bool(4) ? "*" : ""}${name}`;
  return { type, data: id, text: `${prefix}${target}` };
};

const styled = (message: ProtobufMessage): string => {
  const spans = message
    .messages(2)
    .map(
      (span) =>
        ` ${span.string(1)}:${String(span.uint32(2))},${String(span.uint32(3))}`,
    );
  return `(styled string) "${message.string(1)}"${spans.join("")}`;
};

/** An aapt2 `Item` (Resources.proto) rendered as `aapt2 dump` prints it. */
export const protoItemValue = (item: ProtobufMessage): AndroidXmlValue => {
  const ref = item.message(1);
  if (ref !== null) return reference(ref);
  const str = item.message(2) ?? item.message(3);
  if (str !== null)
    return { type: "string", data: null, text: `"${str.string(1)}"` };
  const style = item.message(4);
  if (style !== null)
    return { type: "string", data: null, text: styled(style) };
  const file = item.message(5);
  if (file !== null)
    return {
      type: "string",
      data: null,
      text: `(file) ${file.string(1)}${FILE_TYPES[file.uint32(2)] ?? ""}`,
    };
  if (item.has(6)) return { type: "boolean", data: 0, text: "(id)" };
  const prim = item.message(7);
  if (prim !== null) return primitive(prim);
  return { type: "null", data: 0, text: "@null" };
};

interface Walk {
  nodes: number;
  readonly problems: AndroidXmlProblem[];
}

const line = (node: ProtobufMessage): number | null => {
  const source = node.message(3);
  return source === null ? null : source.uint32(1);
};

const attributes = (element: ProtobufMessage): AndroidXmlAttribute[] =>
  element.messages(4).map((attribute) => {
    const namespace = attribute.string(1);
    const id = attribute.uint32(5);
    const item = attribute.message(6);
    return {
      namespace: namespace === "" ? null : namespace,
      name: attribute.string(2),
      resource_id: id === 0 ? null : id,
      raw: attribute.string(3),
      value: item === null ? null : protoItemValue(item),
    };
  });

/** Children are decoded with a fresh protobuf depth; MAX_XML_DEPTH bounds the nesting. */
const children = (
  element: ProtobufMessage,
  walk: Walk,
  depth: number,
): AndroidXmlNode[] => {
  const nodes: AndroidXmlNode[] = [];
  for (const field of element.fields) {
    if (field.field !== 5) continue;
    if (field.wire !== 2)
      throw new ProtobufFormatError(
        element.offset,
        "Field 5 is not a message.",
      );
    if (walk.nodes >= MAX_XML_NODES) {
      walk.problems.push({
        offset: field.offset,
        message: `Document holds more than ${String(MAX_XML_NODES)} nodes; decoding stopped.`,
      });
      break;
    }
    const child = new ProtobufMessage(field.bytes, field.offset);
    const nested = child.message(1);
    if (nested !== null) {
      if (depth + 1 >= MAX_XML_DEPTH) {
        walk.problems.push({
          offset: field.offset,
          message: `Elements nest deeper than ${String(MAX_XML_DEPTH)} levels; decoding stopped.`,
        });
        break;
      }
      walk.nodes += 1;
      nodes.push(convert(nested, line(child), walk, depth + 1));
    } else if (child.has(2)) {
      walk.nodes += 1;
      nodes.push({ kind: "text", text: child.string(2), line: line(child) });
    }
    if (walk.problems.length > 0) break;
  }
  return nodes;
};

const convert = (
  element: ProtobufMessage,
  at: number | null,
  walk: Walk,
  depth: number,
): AndroidXmlElement => {
  const namespace = element.string(2);
  return {
    kind: "element",
    namespace: namespace === "" ? null : namespace,
    name: element.string(3),
    line: at,
    namespaces: element.messages(1).map((declaration) => ({
      prefix: declaration.string(1),
      uri: declaration.string(2),
    })),
    attributes: attributes(element),
    children: children(element, walk, depth),
  };
};

/**
 * Decode an aapt2 proto `XmlNode`. A malformed message throws
 * AndroidXmlFormatError at its byte offset; node and depth limits are
 * recorded in `problems` and keep what was read.
 */
export const decodeProtoXml = (bytes: Uint8Array): AndroidXmlDocument => {
  try {
    const node = new ProtobufMessage(bytes);
    const element = node.message(1);
    if (element === null)
      throw new AndroidXmlFormatError(0, "XmlNode holds no root element.");
    const walk: Walk = { nodes: 1, problems: [] };
    const root = convert(element, line(node), walk, 0);
    return {
      encoding: "proto-xml",
      root,
      node_count: walk.nodes,
      problems: walk.problems,
    };
  } catch (error) {
    if (error instanceof ProtobufFormatError)
      throw new AndroidXmlFormatError(error.offset, error.message);
    throw error;
  }
};
