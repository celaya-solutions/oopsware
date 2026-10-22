import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional shadcn classes while honoring caller overrides. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
