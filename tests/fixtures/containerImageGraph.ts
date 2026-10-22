import { open } from "node:fs/promises";

import { probeImageArchive } from "../../src/artifacts/inventory/imageProbe.js";

/** The format the target resolver and the inventory both give a tar: "tar" or an image format. */
export const identifyTargetFormat = async (path: string): Promise<string> => {
  const handle = await open(path, "r");
  try {
    return (
      (await probeImageArchive(handle, (await handle.stat()).size)) ?? "tar"
    );
  } finally {
    await handle.close();
  }
};
