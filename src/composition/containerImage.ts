import { ContainerImageService } from "../application/containerImage/ContainerImageService.js";
import { ContainerImageProvider } from "../containerImage/ContainerImageProvider.js";

/** In-process OCI and Docker image reading; nothing is pulled, started, mounted or run. */
export const createContainerImageService = (): ContainerImageService =>
  new ContainerImageService(new ContainerImageProvider());
