import { WebAssemblyService } from "../application/wasm/WebAssemblyService.js";
import { WebAssemblyProvider } from "../wasm/WebAssemblyProvider.js";

/** In-process WebAssembly decoding; wabt.js runs inside its own WebAssembly memory. */
export const createWebAssemblyService = (): WebAssemblyService =>
  new WebAssemblyService(new WebAssemblyProvider());
