import { LinuxPackageService } from "../application/linuxPackage/LinuxPackageService.js";
import { LinuxPackageProvider } from "../linuxPackage/LinuxPackageProvider.js";

/** In-process .deb, .rpm, AppImage and SquashFS reading; nothing is installed, run or mounted. */
export const createLinuxPackageService = (): LinuxPackageService =>
  new LinuxPackageService(new LinuxPackageProvider());
