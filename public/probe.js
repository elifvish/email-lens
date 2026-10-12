/**
 * Layout and readability checks on a rendered email. Runs in two places with the same code:
 * the UI calls it on its preview iframes, and the server evaluates it inside Playwright pages.
 * Keep it a single self-contained function with no imports.
 *
 * Returns [{ level, check, message }].
 */
export function layoutProbe(win, { mobile = false, mode = "light", screenWidth = null } = {}) {
  const doc = win.document;
  const out = [];
  if (!doc.body) return out;
  const vw = doc.documentElement.clientWidth || win.innerWidth;
  const style = (el) => win.getComputedStyle(el);

  const describe = (el) => {
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const w = el.getAttribute("width") ? `[width=${el.getAttribute("width")}]` : "";
    const text = (el.innerText || el.getAttribute("alt") || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `<${el.tagName.toLowerCase()}${cls}${w}>${text ? ` "${text}"` : ""}`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = style(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };

  // No viewport meta (or a fixed one): mobile clients lay the page out wide and zoom out.
  if (mobile && screenWidth && vw > screenWidth + 1) {
    out.push({
      level: "error",
      check: "shrunk",
      message: `Phones lay it out ${vw}px wide and zoom out to fit (to about a third of the size on a 320px screen), so text becomes hard to read. Add <meta name="viewport" content="width=device-width, initial-scale=1"> and a fluid layout.`,
    });
  }

  // Horizontal overflow: readers have to scroll sideways, or the client shrinks everything.
  const sw = doc.documentElement.scrollWidth;
  if (sw > vw + 1) {
    // Blame the outermost too-wide element that sets its own width (width="600", width: 600px,
    // min-width); that's the line to change. Fall back to the widest element.
    const fixedWidth = (el) => /^\d+$/.test(el.getAttribute("width") ?? "") || /(^|;)\s*(min-)?width\s*:\s*\d+px/i.test(el.getAttribute("style") ?? "") || /^[1-9]\d*(\.\d+)?px$/.test(style(el).minWidth);
    let culprit = null;
    let widest = null;
    for (const el of doc.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width <= vw + 1 || !visible(el)) continue;
      if (!widest || r.width > widest.getBoundingClientRect().width) widest = el;
      if (!culprit && fixedWidth(el)) culprit = el;
    }
    culprit ??= widest;
    const w = culprit ? Math.round(culprit.getBoundingClientRect().width) : sw;
    out.push({
      level: mobile ? "error" : "warn",
      check: "overflow",
      message: `Content is ${w}px wide, wider than the screen, so it scrolls sideways or gets shrunk.${culprit ? ` Set by ${describe(culprit)}; give it width:100% with a max-width instead of a fixed width.` : ""}`,
    });
  }

  if (mode === "light") {
    for (const img of doc.images) {
      if (img.complete && img.naturalWidth === 0 && img.getAttribute("src")) {
        out.push({ level: "error", check: "broken-image", message: `Image failed to load: ${img.getAttribute("src").slice(0, 140)}` });
      }
    }
  }

  const parseColor = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const ch = [r, g, b].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const bgcolorProbe = doc.createElement("span");
  const legacyColor = (value) => {
    bgcolorProbe.style.color = "";
    bgcolorProbe.style.color = value;
    doc.body.appendChild(bgcolorProbe);
    const c = parseColor(style(bgcolorProbe).color);
    bgcolorProbe.remove();
    return c;
  };
  const backgroundOf = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = style(n);
      if (s.backgroundImage && s.backgroundImage !== "none") return null; // Unknown: text over an image.
      const c = parseColor(s.backgroundColor);
      if (c && c.a > 0.5) return c;
      if (n.getAttribute("bgcolor")) {
        const legacy = legacyColor(n.getAttribute("bgcolor"));
        if (legacy) return legacy;
      }
    }
    const canvas = parseColor(style(doc.documentElement).backgroundColor);
    if (canvas && canvas.a > 0.5) return canvas;
    return win.matchMedia("(prefers-color-scheme: dark)").matches && /dark/.test(style(doc.documentElement).colorScheme) ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  };

  const elements = new Set();
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  while (walker.nextNode()) {
    const el = walker.currentNode.parentElement;
    if (walker.currentNode.textContent.trim() && el && !["SCRIPT", "STYLE", "TITLE"].includes(el.tagName) && visible(el)) elements.add(el);
  }
  const tiny = [];
  const lowContrast = [];
  for (const el of elements) {
    const s = style(el);
    const size = parseFloat(s.fontSize);
    if (mobile && size < 13) tiny.push({ el, size });
    const fg = parseColor(s.color);
    const bg = backgroundOf(el);
    if (!fg || !bg || fg.a < 0.5) continue;
    const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) lowContrast.push({ el, ratio });
  }
  if (tiny.length && mode === "light") {
    tiny.sort((a, b) => a.size - b.size);
    out.push({
      level: "warn",
      check: "text-size",
      message: `${tiny.length} text element(s) under 13px on a phone. iOS Mail enlarges them, which can push the layout wider. Smallest: ${tiny[0].size}px ${describe(tiny[0].el)}`,
    });
  }
  if (lowContrast.length) {
    lowContrast.sort((a, b) => a.ratio - b.ratio);
    const worst = lowContrast[0];
    out.push({
      level: lowContrast[0].ratio < 2 ? "error" : "warn",
      check: "contrast",
      message: `${lowContrast.length} text element(s) below WCAG AA contrast${mode === "dark" ? " in dark mode" : ""}. Worst ${worst.ratio.toFixed(2)}:1 ${describe(worst.el)}`,
    });
  }

  // Links styled as buttons should be comfortable to tap.
  if (mobile && mode === "light") {
    for (const a of doc.querySelectorAll("a[href]")) {
      if (!visible(a)) continue;
      const cell = a.closest("td");
      const own = parseColor(style(a).backgroundColor);
      const cellBg = cell ? parseColor(style(cell).backgroundColor) || (cell.getAttribute("bgcolor") ? legacyColor(cell.getAttribute("bgcolor")) : null) : null;
      const cellIsButton = cell && cellBg && cellBg.a > 0.5 && cell.querySelectorAll("a").length === 1 && cell.innerText.trim() === a.innerText.trim();
      if (!(own && own.a > 0.5) && !cellIsButton) continue;
      const r = (cellIsButton ? cell : a).getBoundingClientRect();
      if (r.height < 40 || r.width < 44) {
        out.push({ level: "warn", check: "tap-target", message: `Button is ${Math.round(r.width)}×${Math.round(r.height)}px; aim for at least 44px tall on phones. ${describe(a)}` });
      }
    }
  }
  return out;
}
