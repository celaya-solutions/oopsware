import { DebugSymbolsService } from "../application/debugSymbols/DebugSymbolsService.js";
import { DebugSymbolsProvider } from "../debugSymbols/DebugSymbolsProvider.js";

/** In-process DWARF reading of ELF and Mach-O debug files; nothing is run or fetched. */
export const createDebugSymbolsService = (): DebugSymbolsService =>
  new DebugSymbolsService(new DebugSymbolsProvider());
