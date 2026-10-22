import { chromium } from "playwright-core";
import { startHostedServer } from "../dist-hosted/library.mjs";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import wabtInit from "wabt";
const directory = await mkdtemp(join(tmpdir(), "oopsware-catalog-browser-"));
const app = await startHostedServer({
  directory,
  host: "127.0.0.1",
  port: 0,
  assets: resolve("dist-hosted/public"),
  worker: resolve("dist-hosted/worker.mjs"),
  // Fixtures are seeded in a quick burst from one address; browsing keeps the production budgets.
  limits: { uploadsPerHour: Infinity, activeUploads: Infinity },
});
const address = app.server.address();
if (!address || typeof address === "string")
  throw new Error("No local address");
const base = `http://127.0.0.1:${address.port}`;
let browser;
try {
  const markdown =
    "# Field notes\n\nA **readable** document for the library.\n\n| File | Purpose |\n| --- | --- |\n| sample.js | Source code |\n\n```js\nexport const curiosity = true;\n```\n\n<script>window.uploadExecuted=true</script>\n\n[unsafe](javascript:alert(1))\n\n![remote](https://example.org/tracking.png)\n";
  // A real module assembled by wabt.js; the page must never instantiate it.
  const wabt = await wabtInit();
  const assembled = wabt.parseWat(
    "shapes.wat",
    `(module $shapes
      (import "host" "report" (func $report (param i32)))
      (type $area (func (param i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 64) "<script>window.wasmExecuted=true</script>")
      (table 2 funcref) (elem (i32.const 0) $square $double)
      (func $square (type $area) local.get 0 local.get 0 i32.mul)
      (func $double (type $area) local.get 0 i32.const 2 i32.mul)
      (func $start i32.const 1 call $report)
      (start $start)
      (func (export "area_of") (param i32 i32) (result i32)
        local.get 1 local.get 0 call_indirect (type $area)))`,
    {},
  );
  assembled.resolveNames();
  const wasmModule = assembled.toBinary({ write_debug_names: true }).buffer;
  assembled.destroy();
  const current = await (await fetch(base + "/api/submissions")).json();
  if (!current.total) {
    for (const [name, source] of [
      ["field-notes.md", markdown],
      ["packet-inspector.py", 'print("hello")'],
      ["hello-world.js", "export const value = 42;"],
      ["system-config.json", '{"version":1}'],
      ["research-notes.txt", "Local fixture. No personal data."],
      ["sample.wasm", "static fixture"],
      ["shapes-module.wasm", wasmModule],
      [
        "archive-readme.md",
        "# Archive guide\n\nRead a report, inspect a file, download the original.",
      ],
      [
        "table.csv",
        'name,note\n"a,b","two\nlines"\n"=HYPERLINK(""https://example.org"")",x,extra\n',
      ],
      ["events.jsonl", '{"n":1}\n{"n":\n{"n":3}\n'],
      [
        "entities.xml",
        '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<r>&x;</r>\n',
      ],
    ]) {
      const file = Buffer.from(source);
      const admitted = await (
        await fetch(base + "/api/submissions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, size: file.length, agreement: true }),
        })
      ).json();
      const headers = { authorization: `Bearer ${admitted.token}` };
      assert.equal(
        (
          await fetch(`${base}/api/submissions/${admitted.id}/chunk?offset=0`, {
            method: "PUT",
            headers,
            body: file,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/api/submissions/${admitted.id}/complete`, {
            method: "POST",
            headers,
          })
        ).status,
        200,
      );
    }
  }
  const counts = await (await fetch(base + "/api/submissions")).json();
  const documentCount = counts.categories.documents;
  const executablePath =
    process.env.CHROME_EXECUTABLE ??
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : chromium.executablePath());
  await access(executablePath).catch(() => {
    throw new Error(
      "Browser verification needs Chromium. Set CHROME_EXECUTABLE to an installed browser.",
    );
  });
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Console errors catch CSP violations and failed resources the pageerror hook misses.
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(base);
  await page.getByText(/discoveries to explore/).waitFor();
  if (process.env.REA_HOSTED_SCREENSHOTS)
    await page.screenshot({
      path: join(process.env.REA_HOSTED_SCREENSHOTS, "desktop.png"),
      fullPage: true,
    });
  await page.getByRole("button", { name: /Documents/ }).click();
  await page.getByText(`${documentCount} discoveries to explore`).waitFor();
  assert.equal(await page.locator(".item-card").count(), documentCount);
  await page
    .getByRole("searchbox", { name: "Search files by name" })
    .fill("field-notes");
  await page.getByText("1 discovery matching “field-notes”").waitFor();
  await page.getByRole("link", { name: "field-notes.md", exact: true }).click();
  await page.locator(".markdown-body h1").waitFor();
  assert.equal(
    await page.locator(".markdown-body h1").textContent(),
    "Field notes",
  );
  assert.equal(await page.locator(".markdown-body table").count(), 1);
  assert.equal(
    await page
      .locator(
        '.markdown-body script,.markdown-body img,.markdown-body a[href^="javascript:"]',
      )
      .count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.uploadExecuted), undefined);
  if (process.env.REA_HOSTED_SCREENSHOTS)
    await page.screenshot({
      path: join(process.env.REA_HOSTED_SCREENSHOTS, "markdown.png"),
      fullPage: true,
    });
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download original" }).click();
  const download = await downloadEvent;
  assert.equal(await readFile(await download.path(), "utf8"), markdown);
  await page.getByRole("tab", { name: "Overview" }).click();
  const mdEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download report .md" }).click();
  assert.match(
    await readFile(await (await mdEvent).path(), "utf8"),
    /## Observations/,
  );
  await page.getByRole("button", { name: "Close details" }).click();
  await page
    .getByRole("button", { name: "Clear filters ×", exact: true })
    .click();
  await page.getByText(`${counts.total} discoveries to explore`).waitFor();
  // Structured text: parser-aware views that never run or fetch what they show.
  const openDocument = async (name) => {
    await page
      .getByRole("searchbox", { name: "Search files by name" })
      .fill(name);
    await page.getByText(`1 discovery matching “${name}”`).waitFor();
    await page.getByRole("link", { name, exact: true }).click();
    await page.locator("#preview-area .preview-tabs").waitFor();
  };
  const problems = async () => {
    await page.getByRole("button", { name: /^Problems/ }).click();
    await page.locator("#preview-area .diagnostic-list").first().waitFor();
    return page.locator("#preview-area").innerText();
  };
  await openDocument("table.csv");
  await page.locator("#preview-area .doc-table").waitFor();
  assert.equal(
    await page
      .locator("#preview-area .doc-table td")
      .filter({ hasText: "two" })
      .first()
      .innerText(),
    "two\nlines",
  );
  assert.equal(await page.locator("#preview-area tr.formula").count(), 1);
  assert.equal(await page.locator("#preview-area .doc-table a").count(), 0);
  assert.match(await problems(), /Row 3 has 3 fields; row 1 has 2/);
  await page.getByRole("button", { name: "Structure" }).click();
  await page
    .locator("#preview-area caption")
    .filter({ hasText: "Parsed parts" })
    .waitFor();
  await page.getByRole("button", { name: "Bytes" }).click();
  await page.getByRole("button", { name: "Structured view" }).waitFor();
  if (process.env.REA_HOSTED_SCREENSHOTS)
    await page.screenshot({
      path: join(process.env.REA_HOSTED_SCREENSHOTS, "structured-text.png"),
      fullPage: true,
    });
  await page.getByRole("button", { name: "Close details" }).click();
  await openDocument("events.jsonl");
  assert.match(await problems(), /line 2, column \d+, byte \d+, record 2/);
  await page.getByRole("button", { name: "Close details" }).click();
  // WebAssembly: decoded structure only; the module never runs.
  await openDocument("shapes-module.wasm");
  await page
    .locator("#preview-area [role=status]")
    .filter({
      hasText: "WebAssembly core module · valid WebAssembly 2.0 · 5 functions",
    })
    .waitFor();
  await page
    .locator("#preview-area caption")
    .filter({ hasText: "Imports" })
    .waitFor();
  assert.match(
    await page.locator("#preview-area").innerText(),
    /<script>window\.wasmExecuted=true<\/script>/,
  );
  await page.getByRole("button", { name: "Functions" }).click();
  await page
    .locator("#preview-area td")
    .filter({ hasText: "(i32, i32) -> (i32)" })
    .waitFor();
  assert.match(
    await page.locator("#preview-area").innerText(),
    /area_of \(export name\)|area_of/,
  );
  const derived = page.getByRole("link", { name: /derived/ });
  const derivedHref = await derived.getAttribute("href");
  assert.match(derivedHref ?? "", /\/outputs\/module\.wat$/);
  const derivedText = Buffer.from(
    await (await fetch(base + derivedHref)).arrayBuffer(),
  );
  const wasmIndex = await (
    await fetch(base + derivedHref.replace(/outputs\/module\.wat$/, "wasm"))
  ).json();
  assert.equal(
    createHash("sha256").update(derivedText).digest("hex"),
    wasmIndex.wat.sha256,
  );
  await page.getByRole("button", { name: "Problems" }).click();
  await page.locator("#preview-area .diagnostic-list").first().waitFor();
  await page.getByRole("button", { name: "Bytes" }).click();
  await page.getByRole("button", { name: "Module view" }).waitFor();
  assert.equal(
    await page.evaluate(() => Reflect.get(window, "wasmExecuted")),
    undefined,
  );
  if (process.env.REA_HOSTED_SCREENSHOTS) {
    await page.getByRole("button", { name: "Module view" }).click();
    await page.screenshot({
      path: join(process.env.REA_HOSTED_SCREENSHOTS, "webassembly.png"),
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Close details" }).click();
  await openDocument("entities.xml");
  assert.equal(
    await page.locator("#preview-area pre.preview-data").innerText(),
    '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<r>&x;</r>\n',
  );
  assert.match(await problems(), /internal subset/);
  assert.doesNotMatch(await page.locator("#preview-area").innerText(), /root:/);
  await page.getByRole("button", { name: "Close details" }).click();
  await page
    .getByRole("button", { name: "Clear filters ×", exact: true })
    .click();
  await page.getByText(`${counts.total} discoveries to explore`).waitFor();
  await page
    .getByRole("button", { name: "Upload a file", exact: false })
    .click();
  await page.locator("#file-input").setInputFiles({
    name: "browser-upload.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Browser upload\n\nUploaded from the form."),
  });
  await page.locator("#agreement").check();
  await page.getByRole("button", { name: "Upload & inspect" }).click();
  await page
    .locator("#investigation-name")
    .filter({ hasText: "browser-upload.md" })
    .waitFor();
  await page.getByRole("button", { name: "Close details" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.getByText(/discoveries to explore/).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  if (process.env.REA_HOSTED_SCREENSHOTS)
    await page.screenshot({
      path: join(process.env.REA_HOSTED_SCREENSHOTS, "mobile.png"),
      fullPage: true,
    });
  // A wide structured table scrolls inside its own frame, not the page.
  await openDocument("table.csv");
  await page.locator("#preview-area .doc-table").waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "structured table overflows the 390px viewport",
  );
  await page.getByRole("button", { name: "Close details" }).click();
  await openDocument("shapes-module.wasm");
  await page.getByRole("button", { name: "Functions" }).click();
  await page.getByRole("table", { name: /^Functions by index/ }).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "WebAssembly function table overflows the 390px viewport",
  );
  await page.getByRole("button", { name: "Close details" }).click();
  assert.equal(
    await page
      .locator("button")
      .filter({ hasText: /API key|Connect AI|chat/i })
      .count(),
    0,
  );
  // New pages render, stay within the mobile viewport, and carry no emoji.
  for (const path of ["/formats", "/privacy", "/terms", "/report", "/about"]) {
    await page.goto(base + path);
    await page.locator("h1").first().waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `${path} overflows the 390px viewport`,
    );
    assert.equal(
      await page.evaluate(() =>
        /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(
          document.body.innerText,
        ),
      ),
      false,
      `${path} contains an emoji`,
    );
  }
  // The file-types filter narrows the list to a matching entry.
  await page.goto(base + "/formats");
  await page.locator(".fmt").first().waitFor();
  await page.getByPlaceholder(/Search a type/).fill("wasm");
  await page.getByRole("heading", { name: "WebAssembly" }).waitFor();
  assert.equal(await page.locator(".fmt:not([hidden])").count(), 1);

  assert.deepEqual(errors, []);
  console.log(
    "PASS: cards, search, category filtering, Markdown + XSS checks, structured text (CSV table, JSONL/XML problems, no entity loading), WebAssembly module view (functions, derived WAT digest, never instantiated), exact downloads, Markdown report export, browser upload, mobile overflow, static pages, formats filter, no emoji, no JS errors.",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
