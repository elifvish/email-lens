/**
 * Checks that need no browser: size limits, structure and accessibility basics that decide
 * whether an email survives clients at all, independent of CSS support.
 */
import { parseDocument } from "htmlparser2";

const GMAIL_CLIP_BYTES = 102 * 1024;

/** Image sources for messages: data: URLs are shortened to their type and size. */
function shortSrc(src = "") {
  const m = /^data:([^;,]+)[^,]*,/.exec(src);
  return m ? `data:${m[1]} (${(src.length / 1024).toFixed(1)} KB inline)` : src.slice(0, 160);
}

export function lint({ html, text = null }) {
  const out = [];
  const add = (level, check, message, help = null) => out.push({ level, check, message, help });
  const bytes = new TextEncoder().encode(html).length;
  const kb = (bytes / 1024).toFixed(1);

  if (bytes > GMAIL_CLIP_BYTES) add("error", "size", `HTML is ${kb} KB. Gmail clips anything over 102 KB and hides the rest behind "[Message clipped]".`);
  else if (bytes > 80 * 1024) add("warn", "size", `HTML is ${kb} KB, close to Gmail's 102 KB clipping limit.`);

  if (text !== null && !text.trim()) add("warn", "plain-text", "No plain-text part. Some clients show nothing useful and spam filters penalise HTML-only mail.");

  const doc = parseDocument(html, { lowerCaseAttributeNames: true });
  const all = [];
  (function walk(n) {
    for (const c of n.children ?? []) {
      if (c.type === "tag" || c.type === "style" || c.type === "script") all.push(c);
      walk(c);
    }
  })(doc);
  const tags = (name) => all.filter((e) => e.name === name);

  if (!tags("meta").some((m) => (m.attribs.name ?? "").toLowerCase() === "viewport")) {
    add("warn", "viewport", "No <meta name=\"viewport\">. Some mobile clients lay the email out at desktop width and shrink it.");
  }
  if (!/^\s*<!doctype/i.test(html)) add("info", "doctype", "No doctype. Clients render in quirks mode, which changes table and image spacing.");
  const htmlEl = tags("html")[0];
  if (!htmlEl?.attribs.lang) add("info", "lang", "No lang attribute on <html>. Screen readers may read it in the wrong language.");
  if (!tags("title")[0]) add("info", "title", "No <title>. Some clients and screen readers show it when the email is opened in a browser.");

  const hasDarkCss = /prefers-color-scheme\s*:\s*dark/i.test(html);
  const hasColorScheme = tags("meta").some((m) => ["color-scheme", "supported-color-schemes"].includes((m.attribs.name ?? "").toLowerCase()));
  if (!hasDarkCss && !hasColorScheme) {
    add("info", "dark-mode", "No dark-mode styles or color-scheme meta. Gmail and Outlook apps will recolour it on their own; check the Forced dark preview.");
  }

  const imgs = tags("img");
  const noAlt = imgs.filter((i) => !("alt" in i.attribs));
  if (noAlt.length) add("warn", "alt", `${noAlt.length} image(s) without an alt attribute. With images off or a screen reader, they vanish or read as a file name.`, noAlt.slice(0, 3).map((i) => shortSrc(i.attribs.src)).join("\n"));
  const noSize = imgs.filter((i) => !i.attribs.width && !/width\s*:/.test(i.attribs.style ?? ""));
  if (noSize.length) add("info", "img-width", `${noSize.length} image(s) without a width. Outlook for Windows shows them at their natural pixel size.`, noSize.slice(0, 3).map((i) => shortSrc(i.attribs.src)).join("\n"));
  const insecure = imgs.filter((i) => /^http:\/\//i.test(i.attribs.src ?? ""));
  if (insecure.length) add("warn", "http-images", `${insecure.length} image(s) loaded over http://. Several clients block or warn about insecure images.`);
  const local = imgs.filter((i) => /^(https?:\/\/)?(localhost|127\.|[^/]+\.localhost|[^/]+\.local\b|[^/]+\.test\b)/i.test(i.attribs.src ?? "") || /^(file:|\/[^/])/.test(i.attribs.src ?? ""));
  if (local.length) add("error", "local-images", `${local.length} image(s) point at a local or relative URL that recipients can't load.`, local.slice(0, 3).map((i) => shortSrc(i.attribs.src)).join("\n"));

  const links = tags("a").filter((a) => a.attribs.href);
  const emptyLinks = tags("a").filter((a) => !a.attribs.href || a.attribs.href === "#");
  if (emptyLinks.length) add("warn", "links", `${emptyLinks.length} link(s) with no destination (missing href or href="#").`);
  const localLinks = links.filter((a) => /^(https?:\/\/)?(localhost|127\.|[^/]+\.localhost|[^/]+\.test\b)/i.test(a.attribs.href));
  if (localLinks.length) add("warn", "links", `${localLinks.length} link(s) point at a local host. Expected on a dev setup; a bug if it reaches users.`, localLinks.slice(0, 3).map((a) => a.attribs.href).join("\n"));

  if (tags("script").length) add("warn", "script", "Contains <script>. Every email client strips scripts; nothing in them will run.");
  if (tags("form").length) add("info", "form", "Contains a <form>. Many clients disable or strip forms; link to a web page instead.");
  if (tags("video").length || tags("audio").length) add("info", "media", "Contains <video>/<audio>. Most clients don't play inline media; include a fallback image link.");
  if (tags("link").some((l) => /stylesheet/i.test(l.attribs.rel ?? ""))) add("warn", "external-css", "Loads an external stylesheet. Gmail, Outlook and most webmail ignore <link> stylesheets; inline the CSS.");
  if (/<svg[\s>]/i.test(html)) add("info", "svg", "Contains inline SVG. Gmail and Outlook don't render it; use PNG for anything that must show.");

  const styleBytes = tags("style").reduce((n, s) => n + s.children.map((c) => c.data ?? "").join("").length, 0);
  if (styleBytes > 16 * 1024) add("warn", "style-size", `Embedded CSS is ${(styleBytes / 1024).toFixed(1)} KB. Gmail drops a whole <style> block over ~16 KB.`);

  const order = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
