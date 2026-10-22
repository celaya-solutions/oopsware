import { JvmService } from "../application/jvm/JvmService.js";
import { JvmProvider } from "../jvm/JvmProvider.js";

/** In-process class file, JAR and AAR parsing; no JVM is started. */
export const createJvmService = (): JvmService =>
  new JvmService(new JvmProvider());
