/**
 * Real-engine renders with Playwright: WebKit (Apple Mail / iOS Mail), Chromium (webmail,
 * Android) and Gecko (Thunderbird). Optional: without Playwright or its browsers, the UI still
 * works with in-browser previews only.
 *
 * Scripts are disabled in every page, as in every email client.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layoutProbe } from "../public/probe.js";
import { applyMode, DEVICES, MODES } from "../public/variants.js";

const browsers = new Map();
let playwright = null;

async function engine(name) {
  playwright ??= await import("playwright").catch(() => null);
  if (!playwright) throw new Error("Playwright isn't installed. Run `npm install` and `npm run browsers`.");
  if (!browsers.has(name)) {
    browsers.set(
      name,
      playwright[name].launch().catch((e) => {
        browsers.delete(name);
        throw new Error(`${name} isn't available (${e.message.split("\n")[0]}). Run \`npm run browsers\`.`);
      }),
    );
  }
  return browsers.get(name);
}

export async function renderAvailable() {
  playwright ??= await import("playwright").catch(() => null);
  if (!playwright) return { available: false, engines: [] };
  const { existsSync } = await import("node:fs");
  const engines = ["chromium", "webkit", "firefox"].filter((n) => {
    try {
      return existsSync(playwright[n].executablePath());
    } catch {
      return false;
    }
  });
  return { available: engines.length > 0, engines };
}

export async function closeBrowsers() {
  for (const b of browsers.values()) await (await b).close().catch(() => {});
  browsers.clear();
}

/**
 * A real-engine page for one device and mode with the email loaded. Scripts are off, as in
 * every email client. Caller closes the returned context.
 */
export async function openEmailPage(html, device, mode) {
  const browser = await engine(device.engine);
  const ctx = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.mobile ? 2 : 1,
    javaScriptEnabled: false,
    colorScheme: mode.key === "dark" ? "dark" : "light",
    ...(device.engine === "firefox" ? {} : { isMobile: device.mobile, hasTouch: device.mobile }),
  });
  try {
    const page = await ctx.newPage();
    await page.setContent(applyMode(html, mode.key, { emulatedScheme: true }), { waitUntil: "load", timeout: 30000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    return { ctx, page };
  } catch (e) {
    await ctx.close();
    throw e;
  }
}

/** Layout findings for a loaded page, tagged with where they were seen. */
export async function probePage(page, device, mode) {
  if (!["light", "dark", "no-style"].includes(mode.key)) return [];
  const opts = { mobile: device.mobile, mode: mode.key, screenWidth: device.width };
  const issues = await page.evaluate(`(${layoutProbe.toString()})(window, ${JSON.stringify(opts)})`);
  return issues.map((i) => ({ ...i, where: `${device.label} (${device.engine}), ${mode.label}` }));
}

/**
 * Render html on each device × mode and write full-page JPEGs to outDir (CLI --render).
 * Returns { shots: [{ device, mode, engine, file }], findings }.
 */
export async function render(html, { outDir, devices = DEVICES.map((d) => d.key), modes = MODES.map((m) => m.key), prefix = "shot" }) {
  mkdirSync(outDir, { recursive: true });
  const deviceList = DEVICES.filter((d) => devices.includes(d.key));
  const modeList = MODES.filter((m) => modes.includes(m.key));
  const findings = [];
  const perDevice = await Promise.all(
    deviceList.map(async (device) => {
      const shots = [];
      for (const mode of modeList) {
        const { ctx, page } = await openEmailPage(html, device, mode);
        try {
          findings.push(...(await probePage(page, device, mode)));
          const file = `${prefix}-${device.key}-${mode.key}.jpg`;
          writeFileSync(join(outDir, file), await page.screenshot({ fullPage: true, type: "jpeg", quality: 80 }));
          shots.push({ device: device.key, mode: mode.key, engine: device.engine, file });
        } finally {
          await ctx.close();
        }
      }
      return shots;
    }),
  );
  return { shots: perDevice.flat(), findings: mergeFindings(findings) };
}

/** One entry per distinct problem, listing every device/mode it appeared on. */
export function mergeFindings(list) {
  const map = new Map();
  for (const f of list) {
    const key = `${f.level}|${f.check}|${f.message}`;
    const hit = map.get(key) ?? { level: f.level, check: f.check, message: f.message, where: [] };
    if (f.where && !hit.where.includes(f.where)) hit.where.push(f.where);
    map.set(key, hit);
  }
  const order = { error: 0, warn: 1, info: 2 };
  return [...map.values()].sort((a, b) => order[a.level] - order[b.level]);
}
