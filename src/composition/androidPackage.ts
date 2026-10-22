import { AndroidPackageService } from "../application/androidPackage/AndroidPackageService.js";
import { AndroidPackageProvider } from "../androidPackage/AndroidPackageProvider.js";

/** In-process DEX, APK, App Bundle, APK set and XAPK reading; nothing is installed or run. */
export const createAndroidPackageService = (): AndroidPackageService =>
  new AndroidPackageService(new AndroidPackageProvider());
