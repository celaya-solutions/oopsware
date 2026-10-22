import type {
  BlobCheck,
  ContainerImageReport,
  ImagePlatform,
} from "../domain/containerImage/containerImage.js";
import { pairs, text, textList } from "./imageModel.js";

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;

type Config = NonNullable<ContainerImageReport["config"]>;

/** Keys of a Docker "set" object such as ExposedPorts: `{"80/tcp": {}}`. */
const keys = (value: unknown): string[] =>
  Object.keys(record(value) ?? {}).sort();

/** The platform the configuration itself declares. */
export const configPlatform = (document: unknown): ImagePlatform | null => {
  const source = record(document);
  if (source === null) return null;
  return {
    os: text(source.os),
    architecture: text(source.architecture),
    variant: text(source.variant),
    os_version: text(source["os.version"]),
  };
};

/**
 * Read an image configuration. Every field is a declaration the image author
 * (or build tool) wrote; none of it is observed runtime behavior.
 */
export const readConfig = (document: unknown, blob: BlobCheck): Config => {
  const source = record(document);
  const runtime = record(source?.config);
  const rootfs = record(source?.rootfs);
  let layer = 0;
  const history = Array.isArray(source?.history)
    ? source.history.map((raw: unknown) => {
        const step = record(raw);
        const empty = step?.empty_layer === true;
        return {
          created: text(step?.created),
          created_by: text(step?.created_by),
          author: text(step?.author),
          comment: text(step?.comment),
          empty_layer: empty,
          layer_index: empty ? null : layer++,
        };
      })
    : [];
  const list = (value: unknown): string[] | null =>
    Array.isArray(value) ? textList(value) : null;
  return {
    blob,
    architecture: text(source?.architecture),
    os: text(source?.os),
    variant: text(source?.variant),
    created: text(source?.created),
    author: text(source?.author),
    user: text(runtime?.User),
    working_dir: text(runtime?.WorkingDir),
    stop_signal: text(runtime?.StopSignal),
    env: textList(runtime?.Env),
    entrypoint: list(runtime?.Entrypoint),
    cmd: list(runtime?.Cmd),
    exposed_ports: keys(runtime?.ExposedPorts),
    volumes: keys(runtime?.Volumes),
    labels: pairs(runtime?.Labels).map(([key, value]) => ({ key, value })),
    diff_ids: textList(rootfs?.diff_ids),
    history,
  };
};
