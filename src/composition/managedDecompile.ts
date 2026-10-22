import { ManagedDecompileService } from "../application/managedDecompile/ManagedDecompileService.js";
import { IlspyProvider } from "../dotnet/ilspy/IlspyProvider.js";

/** .NET reconstruction with an owner-installed, digest-pinned ilspycmd. */
export const createManagedDecompileService = (): ManagedDecompileService =>
  new ManagedDecompileService(new IlspyProvider());
