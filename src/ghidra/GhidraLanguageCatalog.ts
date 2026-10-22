import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { parseXmlDocument } from "../domain/xmlDocument.js";
import { decodeXmlPlistText } from "../domain/propertyListXmlText.js";

import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";

/** One language definition and the compiler specs it declares. */
export interface GhidraLanguageDefinition {
  readonly id: string;
  readonly compilerSpecIds: readonly string[];
}

// Language definitions are small XML files; refuse anything implausibly large.
const MAX_LDEFS_BYTES = 4 * 1024 * 1024;
// Processor modules ship under Processors; installed extensions may add more.
const LANGUAGE_ROOTS = ["Ghidra/Processors", "Ghidra/Extensions"] as const;

interface RetainedLanguageFile {
  readonly path: string;
  readonly owner: OwnedFileHandle<FileHandle>;
}

/** Language definition handles whose close is unconfirmed but retryable. */
const pendingLanguageFileCleanup = new Set<RetainedLanguageFile>();

/**
 * Cleanup of one or more language definition handles is unconfirmed. Any
 * read failure that preceded it is kept as the primary failure.
 */
export class GhidraLanguageCatalogCleanupError extends Error {
  constructor(
    readonly paths: readonly string[],
    readonly causes: readonly unknown[],
    readonly readFailure?: unknown,
  ) {
    super(
      `Language definition cleanup is unconfirmed: ${paths.join(", ")}`,
      readFailure === undefined ? undefined : { cause: readFailure },
    );
  }
}

/** Close one owner; retain it only while a later close can still succeed. */
const closeLanguageFile = async (
  file: RetainedLanguageFile,
): Promise<unknown> => {
  try {
    await file.owner.close();
    pendingLanguageFileCleanup.delete(file);
    return undefined;
  } catch (cause: unknown) {
    // Descriptor invalidation does not prove that this owner confirmed close.
    // Keep even sticky failures in the lifecycle scope so later reads surface
    // the unresolved cleanup instead of silently abandoning ownership.
    pendingLanguageFileCleanup.add(file);
    return cause;
  }
};

/** Retry every retained owner before reporting the failures together. */
const retryLanguageFileCleanup = async (): Promise<void> => {
  const failed: { readonly path: string; readonly cause: unknown }[] = [];
  for (const file of pendingLanguageFileCleanup) {
    const cause = await closeLanguageFile(file);
    if (cause !== undefined) failed.push({ path: file.path, cause });
  }
  if (failed.length > 0)
    throw new GhidraLanguageCatalogCleanupError(
      failed.map(({ path }) => path),
      failed.map(({ cause }) => cause),
    );
};

/** Parse the `<language>` elements of one `.ldefs` document. */
export const parseGhidraLanguageDefinitions = (
  text: string,
): readonly GhidraLanguageDefinition[] => {
  const definitions: GhidraLanguageDefinition[] = [];
  const parsed = parseXmlDocument(text, {
    doctype: "allow",
    lineEndings: "normalize",
  });
  if (!parsed.ok) throw parsed.error;
  const document = parsed.value;
  const root = document.documentElement;
  if (root?.tagName !== "language_definitions")
    throw new SyntaxError("Expected Ghidra language_definitions XML root");
  for (const language of Array.from(root.getElementsByTagName("language"))) {
    if (language.parentNode !== root) continue;
    const id = language.getAttribute("id");
    if (id === null) continue;
    const compilerSpecIds: string[] = [];
    for (const compiler of Array.from(
      language.getElementsByTagName("compiler"),
    )) {
      if (compiler.parentNode !== language) continue;
      const compilerId = compiler.getAttribute("id");
      if (compilerId !== null) compilerSpecIds.push(compilerId);
    }
    definitions.push({ id, compilerSpecIds });
  }
  return definitions;
};

const languageDirectories = async (installDir: string): Promise<string[]> => {
  const directories: string[] = [];
  for (const root of LANGUAGE_ROOTS) {
    let modules: string[];
    try {
      modules = await readdir(join(installDir, root));
    } catch {
      continue;
    }
    for (const module of modules.sort())
      directories.push(join(installDir, root, module, "data", "languages"));
  }
  return directories;
};

/** Read at most the catalog limit; undefined marks an oversized file. */
const readLanguageDefinitionFile = async (
  path: string,
): Promise<Buffer | undefined> => {
  await retryLanguageFileCleanup();
  const file = { path, owner: new OwnedFileHandle(await open(path, "r")) };
  let read:
    | { readonly ok: true; readonly bytes: Buffer | undefined }
    | { readonly ok: false; readonly cause: unknown };
  try {
    read = {
      ok: true,
      bytes: await readBoundedFileBytes(file.owner.handle, MAX_LDEFS_BYTES),
    };
  } catch (cause: unknown) {
    read = { ok: false, cause };
  }
  const cleanup = await closeLanguageFile(file);
  if (cleanup !== undefined)
    throw new GhidraLanguageCatalogCleanupError(
      [path],
      [cleanup],
      read.ok ? undefined : read.cause,
    );
  if (!read.ok) throw read.cause;
  return read.bytes;
};

/** Read every language definition shipped by one Ghidra installation. */
export const readGhidraLanguageCatalog = async (
  installDir: string,
): Promise<readonly GhidraLanguageDefinition[]> => {
  // Surface retained cleanup even when this catalog has no definitions to read.
  await retryLanguageFileCleanup();
  const definitions: GhidraLanguageDefinition[] = [];
  for (const directory of await languageDirectories(installDir)) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".ldefs")) continue;
      const bytes = await readLanguageDefinitionFile(join(directory, entry));
      if (bytes === undefined) continue;
      // The XML byte owner validates encoding and declaration before syntax
      // parsing; a literal U+FFFD cannot diagnose invalid source bytes.
      definitions.push(
        ...parseGhidraLanguageDefinitions(decodeXmlPlistText(bytes)),
      );
    }
  }
  return definitions;
};

/**
 * Check a configured import language against the installation before launch,
 * so an unknown ID fails as configuration instead of as a failed import.
 */
export const admitGhidraLanguageOverride = (
  override: GhidraLanguageOverride,
  catalog: readonly GhidraLanguageDefinition[],
  providerVersion: string,
): ConfigurationError | null => {
  const language = catalog.find((value) => value.id === override.languageId);
  if (language === undefined)
    return new ConfigurationError("Invalid REA environment configuration", {
      settings: [
        {
          setting: "REA_GHIDRA_LANGUAGE_ID",
          constraint: `is not a language defined by Ghidra ${providerVersion}`,
        },
      ],
    });
  if (
    override.compilerSpecId !== undefined &&
    !language.compilerSpecIds.includes(override.compilerSpecId)
  )
    return new ConfigurationError("Invalid REA environment configuration", {
      settings: [
        {
          setting: "REA_GHIDRA_COMPILER_SPEC_ID",
          constraint: `must be one of the selected language's compiler specs: ${language.compilerSpecIds.join(", ")}`,
        },
      ],
    });
  return null;
};
