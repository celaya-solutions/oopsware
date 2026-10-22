import { access, constants } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { chromium } from "playwright-core";
import type { PdfRendererPort } from "../application/report/ReportService.js";

/** Fixed install paths tried in order; Oopsware installs no browser. */
const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
  ],
};

const TIMEOUT_MS = 60_000;

const NO_BROWSER =
  "No Chromium-family browser was found. Install Google Chrome, Chromium, Microsoft Edge or Brave, or set REA_BROWSER_EXECUTABLE to one, or open the HTML report and print it to PDF.";

const runnable = async (path: string) => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Prints report HTML to PDF in an owned headless browser: JavaScript off,
 * every request refused, a throwaway profile, and a 60-second limit.
 */
export class ChromiumPdfRenderer implements PdfRendererPort {
  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly platform: string = process.platform,
  ) {}

  async #browser(): Promise<string | { reason: string }> {
    const chosen = this.environment.REA_BROWSER_EXECUTABLE;
    if (chosen !== undefined && chosen !== "") {
      if (!isAbsolute(chosen) || !(await runnable(chosen)))
        return {
          reason: `REA_BROWSER_EXECUTABLE (${chosen}) is not an absolute path to a program this user can run.`,
        };
      return chosen;
    }
    for (const path of CANDIDATES[this.platform] ?? [])
      if (await runnable(path)) return path;
    return { reason: NO_BROWSER };
  }

  async status() {
    const browser = await this.#browser();
    return typeof browser === "string"
      ? { available: true as const, browser }
      : { available: false as const, reason: browser.reason };
  }

  async render(html: string): Promise<Uint8Array> {
    const executablePath = await this.#browser();
    if (typeof executablePath !== "string")
      throw new Error(executablePath.reason);
    const deadline = Date.now() + TIMEOUT_MS;
    const left = () => Math.max(1, deadline - Date.now());
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      timeout: left(),
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        "--disable-background-networking",
        "--disable-dev-shm-usage",
        ...(this.environment.REA_BROWSER_NO_SANDBOX === "true"
          ? ["--no-sandbox"]
          : []),
      ],
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = (async () => {
        const context = await browser.newContext({
          javaScriptEnabled: false,
          offline: true,
        });
        await context.route("**/*", (route) => route.abort("blockedbyclient"));
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: "load", timeout: left() });
        return page.pdf({
          format: "A4",
          printBackground: true,
          margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" },
        });
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("The PDF took longer than 60 seconds to print.")),
          left(),
        );
      });
      return new Uint8Array(await Promise.race([work, timeout]));
    } finally {
      clearTimeout(timer);
      await browser.close().catch(() => undefined);
    }
  }
}
