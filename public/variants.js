/**
 * Preview modes, applied to the HTML before it is rendered. Shared by the UI's iframe previews
 * and the Playwright renders, so both show the same thing.
 *
 *   light        as sent, with any dark-mode media queries switched off
 *   dark         dark-mode media queries switched on (what Apple Mail / iOS Mail do)
 *   forced-dark  colours inverted, images kept (approximates the Gmail and Outlook apps,
 *                which recolour emails that don't opt in to dark mode)
 *   no-style     <style> and stylesheets removed (Gmail with non-Google accounts, some webmail)
 *   no-images    remote and embedded images blocked (the default in many corporate clients)
 */
export const MODES = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "forced-dark", label: "Forced dark" },
  { key: "no-style", label: "No <style>" },
  { key: "no-images", label: "Images off" },
];

export const DEVICES = [
  { key: "iphone-se", label: "iPhone SE", width: 320, height: 568, mobile: true, engine: "webkit" },
  { key: "iphone", label: "iPhone 15", width: 393, height: 852, mobile: true, engine: "webkit" },
  { key: "android", label: "Android", width: 412, height: 915, mobile: true, engine: "chromium" },
  { key: "ipad", label: "iPad", width: 768, height: 1024, mobile: false, engine: "webkit" },
  { key: "desktop", label: "Desktop webmail", width: 1200, height: 900, mobile: false, engine: "chromium" },
  { key: "thunderbird", label: "Thunderbird", width: 1024, height: 900, mobile: false, engine: "firefox" },
];

const FORCED_DARK_CSS =
  "html{filter:invert(1) hue-rotate(180deg)!important;background:#fff!important}" +
  "img,video,picture,svg,[background],[style*=background-image]{filter:invert(1) hue-rotate(180deg)!important}";

/**
 * @param {string} html
 * @param {string} mode  one of MODES[].key
 * @param {{ emulatedScheme?: boolean }} opts  true when the renderer emulates
 *        prefers-color-scheme itself (Playwright), so media queries are left alone.
 */
export function applyMode(html, mode, { emulatedScheme = false } = {}) {
  let out = html;
  if (!emulatedScheme) out = setColorScheme(out, mode === "dark" ? "dark" : "light");
  if (mode === "no-style") out = out.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<link[^>]+rel=["']?stylesheet[^>]*>/gi, "");
  if (mode === "no-images") out = injectHead(out, `<meta http-equiv="Content-Security-Policy" content="img-src 'none'">`);
  if (mode === "forced-dark") out = injectEnd(out, `<style>${FORCED_DARK_CSS}</style>`);
  return out;
}

/** Make prefers-color-scheme media queries match the given scheme, whatever the OS uses. */
function setColorScheme(html, scheme) {
  const always = "(min-width:0px)";
  const never = "(max-width:0px) and (min-width:1px)";
  return html
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, scheme === "dark" ? always : never)
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, scheme === "light" ? always : never);
}

function injectHead(html, tag) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  return tag + html;
}

function injectEnd(html, tag) {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, tag + "</body>") : html + tag;
}
