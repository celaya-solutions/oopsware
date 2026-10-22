import type { AndroidArtifactReport } from "../../domain/android/androidArtifact.js";
import type {
  ApksApkDescription,
  ApksTargetingDimension,
  ApksToc,
} from "../bundle/toc.js";

type NestedKind = NonNullable<
  AndroidArtifactReport["apk_set"]
>["apks"][number]["kind"];

/** What an APK set's table of contents (or an XAPK manifest) says about one APK path. */
export interface ApkDeclaration {
  readonly path: string;
  readonly kind: NestedKind;
  readonly module: string | null;
  readonly split_id: string | null;
  readonly is_master: boolean | null;
  readonly targeting: readonly string[];
  /** toc.pb variant that lists it; null for asset slices and XAPK declarations. */
  readonly variant: number | null;
}

/** "abi=ARM64_V8A", with the alternatives a device is matched against when there are any. */
export const targetingText = (dimension: ApksTargetingDimension): string =>
  `${dimension.dimension}=${dimension.values.join("|")}${
    dimension.alternatives.length === 0
      ? ""
      : ` (alternatives ${dimension.alternatives.join("|")})`
  }`;

const declaration = (
  apk: ApksApkDescription,
  module: string,
  variant: number | null,
): ApkDeclaration => ({
  path: apk.path,
  kind: apk.kind,
  module,
  split_id: apk.split_id,
  is_master: apk.is_master_split,
  targeting: apk.targeting.map(targetingText),
  variant,
});

/** Every APK path toc.pb declares, once per variant or asset slice set that lists it. */
export const tocDeclarations = (toc: ApksToc): ApkDeclaration[] => [
  ...toc.variants.flatMap((variant) =>
    variant.apk_sets.flatMap((set) =>
      set.apks.map((apk) =>
        declaration(apk, set.module.name, variant.variant_number),
      ),
    ),
  ),
  ...toc.asset_slice_sets.flatMap((set) =>
    set.apks.map((apk) => declaration(apk, set.module.name, null)),
  ),
];
