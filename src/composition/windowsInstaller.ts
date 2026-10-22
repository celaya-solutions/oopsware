import { WindowsInstallerService } from "../application/windowsInstaller/WindowsInstallerService.js";
import { WindowsInstallerProvider } from "../windowsInstaller/WindowsInstallerProvider.js";

/** In-process MSI and MSIX/AppX reading; nothing is installed, registered or run. */
export const createWindowsInstallerService = (): WindowsInstallerService =>
  new WindowsInstallerService(new WindowsInstallerProvider());
