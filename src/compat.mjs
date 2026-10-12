/**
 * Email client compatibility, from caniemail.com data.
 *
 * detectFeatures(html) walks the HTML and every stylesheet / style attribute in it and maps
 * what it finds onto caniemail feature slugs. checkCompat(html) then looks up each feature's
 * support on every client (latest tested version per platform) and scores each client.
 *
 * Unlike the npm checkers, a client with no data for a feature is reported as "unknown"
 * instead of throwing.
 */
import { readFileSync } from "node:fs";
import { parse as parseSelector } from "css-what";
import { parseDocument } from "htmlparser2";
import postcss from "postcss";
import { DATA_FILE } from "./paths.mjs";

let DATA = null;
let BY_SLUG = null;

export function loadData(file = DATA_FILE) {
  DATA = JSON.parse(readFileSync(file, "utf8"));
  BY_SLUG = new Map(DATA.data.map((f) => [f.slug, f]));
  return DATA;
}

function data() {
  return DATA ?? loadData();
}

export function dataInfo() {
  const d = data();
  return { updated: d.last_update_date, features: d.data.length, clients: listClients().length };
}

/** Every family/platform pair that appears anywhere in the data, e.g. gmail/android. */
export function listClients() {
  const d = data();
  const seen = new Map();
  for (const f of d.data) {
    for (const [family, platforms] of Object.entries(f.stats ?? {})) {
      for (const platform of Object.keys(platforms)) {
        const id = `${family}.${platform}`;
        if (!seen.has(id)) {
          const familyName = d.nicenames.family[family] ?? family;
          const platformName = d.nicenames.platform[platform] ?? platform;
          const name = platformName.toLowerCase().includes(familyName.toLowerCase()) ? platformName : `${familyName} ${platformName}`;
          seen.set(id, { id, family, platform, name, familyName, platformName });
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------
// Detection

const HTML_TAGS = new Set([
  "abbr", "acronym", "address", "audio", "base", "bdi", "blockquote", "body", "code", "del", "dfn",
  "dialog", "div", "form", "hr", "img", "link", "marquee", "meter", "object", "p", "picture", "pre",
  "progress", "rp", "rt", "ruby", "select", "small", "span", "strike", "strong", "style", "svg",
  "table", "textarea", "video", "wbr",
]);
const SEMANTIC_TAGS = new Set(["article", "aside", "details", "figcaption", "figure", "footer", "header", "main", "mark", "nav", "section", "summary", "time"]);
const LIST_TAGS = new Set(["ul", "ol", "li", "dl", "dt", "dd"]);
const HTML_ATTRS = new Set(["align", "background", "cellpadding", "cellspacing", "dir", "height", "hidden", "lang", "required", "role", "srcset", "target", "valign", "width"]);
const ARIA_ATTRS = new Set(["aria-describedby", "aria-hidden", "aria-label", "aria-labelledby", "aria-live"]);
const INPUT_TYPES = new Set(["checkbox", "hidden", "radio", "reset", "submit", "text"]);
const IMAGE_EXT = { apng: "apng", avif: "avif", bmp: "bmp", gif: "gif", hdr: "hdr", heic: "heif", heif: "heif", ico: "ico", jpg: "jpg", jpeg: "jpg", mp4: "mp4", png: "png", svg: "svg", tif: "tiff", tiff: "tiff", webp: "webp" };

/** Property → slug, where the slug isn't simply `css-<property>`. */
const PROPERTY_SLUGS = {
  "row-gap": "css-gap", "column-gap": "css-gap",
  "grid-template-columns": "css-grid-template", "grid-template-rows": "css-grid-template", "grid-template-areas": "css-grid-template",
  "border-top-left-radius": "css-border-radius", "border-top-right-radius": "css-border-radius",
  "border-bottom-left-radius": "css-border-radius", "border-bottom-right-radius": "css-border-radius",
  "border-start-start-radius": "css-border-radius-logical", "border-start-end-radius": "css-border-radius-logical",
  "border-end-start-radius": "css-border-radius-logical", "border-end-end-radius": "css-border-radius-logical",
  "border-inline": "css-border-inline-block", "border-block": "css-border-inline-block",
  "border-inline-start": "css-border-inline-block-individual", "border-inline-end": "css-border-inline-block-individual",
  "border-block-start": "css-border-inline-block-individual", "border-block-end": "css-border-inline-block-individual",
  "margin-inline": "css-margin-inline-block", "margin-block": "css-margin-inline-block",
  "margin-inline-start": "css-margin-inline-start-end", "margin-inline-end": "css-margin-inline-start-end",
  "margin-block-start": "css-margin-block-start-end", "margin-block-end": "css-margin-block-start-end",
  "padding-inline": "css-padding-inline-block", "padding-block": "css-padding-inline-block",
  "padding-inline-start": "css-padding-inline-start-end", "padding-inline-end": "css-padding-inline-start-end",
  "padding-block-start": "css-padding-inline-start-end", "padding-block-end": "css-padding-inline-start-end",
  left: "css-left-right-top-bottom", right: "css-left-right-top-bottom", top: "css-left-right-top-bottom", bottom: "css-left-right-top-bottom",
  "block-size": "css-block-inline-size",
  "overflow-x": "css-overflow", "overflow-y": "css-overflow",
  "contain-intrinsic-size": "css-intrinsic-size",
  columns: "css-column-layout-properties", "column-width": "css-column-layout-properties", "column-rule": "css-column-layout-properties",
  "column-span": "css-column-layout-properties", "column-fill": "css-column-layout-properties",
};
const PREFIX_SLUGS = [
  [/^margin-(top|right|bottom|left)$/, "css-margin"],
  [/^padding-(top|right|bottom|left)$/, "css-padding"],
  [/^border-(top|right|bottom|left)(-(width|style|color))?$|^border-(width|style|color)$/, "css-border"],
  [/^border-(inline|block)(-(start|end))?-(width|style|color)$/, "css-border-inline-block-longhand"],
  [/^animation(-|$)/, "css-animation"],
  [/^transition(-|$)/, "css-transition"],
  [/^scroll-snap-/, "css-scroll-snap"],
  [/^column-rule-/, "css-column-layout-properties"],
  [/^text-emphasis-(style|color)$/, "css-text-emphasis"],
];
const UNITS = ["ch", "cm", "em", "ex", "in", "mm", "pc", "pt", "px", "rem", "vh", "vmax", "vmin", "vw"];

/** Feature slug → { count, samples[] } */
class Found extends Map {
  add(slug, sample) {
    if (!BY_SLUG.has(slug)) return;
    const hit = this.get(slug) ?? { count: 0, samples: [] };
    hit.count++;
    if (sample && hit.samples.length < 3 && !hit.samples.includes(sample)) hit.samples.push(sample.slice(0, 140));
    this.set(slug, hit);
  }
}

export function detectFeatures(html) {
  data();
  const found = new Found();
  if (/^\s*<!doctype/i.test(html)) found.add("html-doctype", html.match(/^\s*(<!doctype[^>]*>)/i)[1]);
  if (/<html[^>]*\s⚡4email|<html[^>]*\samp4email/i.test(html)) found.add("amp", "<html ⚡4email>");

  const doc = parseDocument(html, { lowerCaseAttributeNames: true, recognizeSelfClosing: true });
  walk(doc, (node) => {
    if (node.type === "comment") {
      const text = String(node.data).trim();
      // Outlook conditional comments are a deliberate technique, not a content comment.
      if (!/^\[if |^<!\[endif\]|^\[endif\]/i.test(text)) found.add("html-comments", `<!--${text.slice(0, 60)}-->`);
      return;
    }
    if (node.type === "style" || node.type === "tag" || node.type === "script") checkElement(node, found);
  });
  return found;
}

function walk(node, fn) {
  for (const child of node.children ?? []) {
    fn(child);
    walk(child, fn);
  }
}

function checkElement(el, found) {
  const tag = el.name.toLowerCase();
  const attrs = el.attribs ?? {};
  const open = openingTag(el);

  if (HTML_TAGS.has(tag)) found.add(`html-${tag}`, open);
  if (/^h[1-6]$/.test(tag)) found.add("html-h1-h6", open);
  if (SEMANTIC_TAGS.has(tag)) found.add("html-semantics", open);
  if (LIST_TAGS.has(tag)) found.add("html-lists", open);
  if (tag === "map" || tag === "area") found.add("html-image-maps", open);
  if (tag === "button" && ["reset", "submit"].includes(attrs.type)) found.add(`html-button-${attrs.type}`, open);
  if (tag === "input" && INPUT_TYPES.has((attrs.type ?? "text").toLowerCase())) found.add(`html-input-${(attrs.type ?? "text").toLowerCase()}`, open);
  if (tag === "meta" && ["color-scheme", "supported-color-schemes"].includes((attrs.name ?? "").toLowerCase())) found.add("html-meta-color-scheme", open);
  if (tag === "a" && attrs.href) {
    if (attrs.href.startsWith("#") && attrs.href.length > 1) found.add("html-anchor-links", open);
    if (/^mailto:/i.test(attrs.href)) found.add("html-mailto-links", open);
  }
  if ((tag === "img" || tag === "source") && (attrs.src || attrs.srcset)) checkImage(attrs.src ?? attrs.srcset, found, open);

  for (const name of Object.keys(attrs)) {
    if (HTML_ATTRS.has(name)) found.add(`html-${name}`, open);
    if (ARIA_ATTRS.has(name)) found.add(`html-${name}`, open);
    if (name === "loading") found.add("html-loading-attribute", open);
    if (name === "popover") found.add("html-popover", open);
    if (name === "inert") found.add("css-inert-attribute", open);
    if (name === "command" || name === "commandfor") found.add("html-command-attribute", open);
  }
  if (attrs.style) checkCss(`x{${attrs.style}}`, found, { inline: true });
  if (tag === "style") checkCss(el.children.map((c) => c.data ?? "").join(""), found, { inline: false });
}

function openingTag(el) {
  const attrs = Object.entries(el.attribs ?? {})
    .map(([k, v]) => (v === "" ? k : `${k}="${v.length > 40 ? v.slice(0, 40) + "…" : v}"`))
    .join(" ");
  return `<${el.name}${attrs ? " " + attrs : ""}>`;
}

function checkImage(src, found, sample) {
  const data = /^data:image\/([a-z0-9.+-]+)/i.exec(src);
  if (data) {
    found.add("image-base64", sample);
    const type = data[1].toLowerCase().replace("svg+xml", "svg");
    if (IMAGE_EXT[type]) found.add(`image-${IMAGE_EXT[type]}`, sample);
    return;
  }
  const ext = /\.([a-z0-9]+)(?:[?#\s,]|$)/i.exec(src)?.[1]?.toLowerCase();
  if (ext && IMAGE_EXT[ext]) found.add(`image-${IMAGE_EXT[ext]}`, sample);
}

function checkCss(css, found, { inline }) {
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    return; // Malformed CSS: clients will drop it too; the render shows the effect.
  }
  root.walk((node) => {
    if (node.type === "comment" && !inline) found.add("css-comments", `/*${node.text.slice(0, 60)}*/`);
    if (node.type === "atrule") checkAtRule(node, found);
    if (node.type === "rule") {
      if (!inline) checkSelector(node.selector, found);
      if (node.parent?.type === "rule") found.add("css-nesting", node.selector);
    }
    if (node.type === "decl") checkDeclaration(node, found);
  });
}

function checkAtRule(node, found) {
  const sample = `@${node.name} ${node.params}`.trim();
  const name = node.name.toLowerCase();
  if (["font-face", "import", "keyframes", "supports"].includes(name)) found.add(`css-at-${name}`, sample);
  if (name === "media") {
    found.add("css-at-media", sample);
    const p = node.params.toLowerCase();
    if (p.includes("prefers-color-scheme")) found.add("css-at-media-prefers-color-scheme", sample);
    if (p.includes("prefers-reduced-motion")) found.add("css-at-media-prefers-reduced-motion", sample);
    if (/\bhover\b|any-hover/.test(p)) found.add("css-at-media-hover", sample);
    if (p.includes("orientation")) found.add("css-at-media-orientation", sample);
    if (/device-pixel-ratio|resolution/.test(p)) found.add("css-at-media-device-pixel-ratio", sample);
  }
}

function checkSelector(selector, found) {
  let groups;
  try {
    groups = parseSelector(selector);
  } catch {
    return;
  }
  if (groups.length > 1) found.add("css-selector-grouping", selector);
  for (const group of groups) {
    let compound = 0;
    for (const t of group) {
      switch (t.type) {
        case "tag": found.add("css-selector-type", selector); compound++; break;
        case "universal": found.add("css-selector-universal", selector); compound++; break;
        case "attribute":
          if (t.name === "class" && t.action === "element") found.add("css-selector-class", selector);
          else if (t.name === "id" && t.action === "equals") found.add("css-selector-id", selector);
          else found.add("css-selector-attribute", selector);
          compound++;
          break;
        case "pseudo":
          found.add(`css-pseudo-class-${t.name}`, selector);
          compound++;
          break;
        case "pseudo-element": found.add(`css-pseudo-element-${t.name}`, selector); break;
        case "child": found.add("css-selector-child", selector); break;
        case "descendant": found.add("css-selector-descendant", selector); break;
        case "adjacent": found.add("css-selector-adjacent-sibling", selector); break;
        case "sibling": found.add("css-selector-general-sibling", selector); break;
      }
      if (["child", "descendant", "adjacent", "sibling"].includes(t.type)) {
        if (compound > 1) found.add("css-selector-chaining", selector);
        compound = 0;
      }
    }
    if (compound > 1) found.add("css-selector-chaining", selector);
  }
}

function checkDeclaration(decl, found) {
  const prop = decl.prop.toLowerCase().replace(/^-(webkit|moz|ms|o)-/, "");
  const value = decl.value.toLowerCase();
  const sample = `${decl.prop}: ${decl.value}${decl.important ? " !important" : ""}`;

  if (prop.startsWith("--")) found.add("css-variables", sample);
  else if (BY_SLUG.has(`css-${prop}`) && prop !== "display") found.add(`css-${prop}`, sample);
  if (PROPERTY_SLUGS[prop]) found.add(PROPERTY_SLUGS[prop], sample);
  for (const [re, slug] of PREFIX_SLUGS) if (re.test(prop)) found.add(slug, sample);

  if (prop === "display") {
    found.add("css-display", sample);
    if (/\b(inline-)?flex\b/.test(value)) found.add("css-display-flex", sample);
    else if (/\b(inline-)?grid\b/.test(value)) found.add("css-display-grid", sample);
    else if (value.trim() === "none") found.add("css-display-none", sample);
  }
  if (prop === "background" && /url\(/.test(value)) found.add("css-background-image", sample);
  if (prop === "font-family" && /system-ui|-apple-system/.test(value)) found.add("css-sytem-ui", sample);
  if (decl.important) found.add("css-important", sample);

  if (/var\(--/.test(value)) found.add("css-variables", sample);
  if (/linear-gradient\(/.test(value)) found.add("css-linear-gradient", sample);
  if (/radial-gradient\(/.test(value)) found.add("css-radial-gradient", sample);
  if (/conic-gradient\(/.test(value)) found.add("css-conic-gradient", sample);
  if (/\bcalc\(/.test(value)) found.add("css-unit-calc", sample);
  for (const fn of ["clamp", "min", "max"]) if (new RegExp(`\\b${fn}\\(`).test(value)) found.add(`css-function-${fn}`, sample);
  if (/light-dark\(/.test(value)) found.add("css-function-light-dark", sample);
  if (/\brgba\(/.test(value)) found.add("css-rgba", sample);
  else if (/\brgb\(/.test(value)) found.add("css-rgb", sample);
  if (/\b(hsla?|hwb|lab|lch|oklab|oklch|color)\(|\brgba?\(\s*[\d.]+%?\s+[\d.]/.test(value)) found.add("css-modern-color", sample);
  if (/^\s*initial\s*$/.test(value)) found.add("css-unit-initial", sample);
  if (/\d%/.test(value)) found.add("css-unit-percent", sample);
  for (const unit of UNITS) if (new RegExp(`\\d${unit}\\b`).test(value)) found.add(`css-unit-${unit}`, sample);
}

// ---------------------------------------------------------------------------------------
// Support lookup and scoring

/** "y" | "n" | "a" | "u", plus the note numbers, for the latest tested version. */
export function supportOn(feature, family, platform) {
  const versions = feature.stats?.[family]?.[platform];
  if (!versions) return { support: "u", notes: [], version: null };
  const latest = Object.keys(versions).sort().at(-1);
  const raw = String(versions[latest]);
  const support = raw.trim()[0];
  const notes = [...raw.matchAll(/#(\d+)/g)].map((m) => feature.notes_by_num?.[m[1]]).filter(Boolean);
  return { support: ["y", "n", "a"].includes(support) ? support : "u", notes, version: latest };
}

/**
 * Full compatibility report for one HTML email.
 * clientIds: optional subset like ["gmail.android", "outlook.windows"].
 */
export function checkCompat(html, { clientIds } = {}) {
  const found = detectFeatures(html);
  const clients = listClients().filter((c) => !clientIds?.length || clientIds.includes(c.id));
  const features = [];
  for (const [slug, hit] of found) {
    const f = BY_SLUG.get(slug);
    const support = {};
    for (const c of clients) support[c.id] = supportOn(f, c.family, c.platform);
    const noCount = Object.values(support).filter((s) => s.support === "n").length;
    const partialCount = Object.values(support).filter((s) => s.support === "a").length;
    features.push({
      slug,
      title: f.title,
      category: f.category,
      url: f.url,
      description: f.description,
      count: hit.count,
      samples: hit.samples,
      support,
      noCount,
      partialCount,
    });
  }
  features.sort((a, b) => b.noCount - a.noCount || b.partialCount - a.partialCount || a.title.localeCompare(b.title));

  const scores = clients.map((c) => {
    let known = 0;
    let points = 0;
    const no = [];
    const partial = [];
    for (const f of features) {
      const s = f.support[c.id].support;
      if (s === "u") continue;
      known++;
      if (s === "y") points += 1;
      else if (s === "a") {
        points += 0.5;
        partial.push(f.slug);
      } else no.push(f.slug);
    }
    return { ...c, score: known ? Math.round((points / known) * 1000) / 10 : null, no, partial, known };
  });
  const scored = scores.filter((s) => s.score != null);
  const overall = scored.length ? Math.round((scored.reduce((n, s) => n + s.score, 0) / scored.length) * 10) / 10 : null;

  return { data: dataInfo(), overall, clients: scores, features };
}
