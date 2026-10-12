import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCompat, detectFeatures, listClients, supportOn } from "../src/compat.mjs";

const slugs = (html) => [...detectFeatures(html).keys()];

test("detects CSS properties, values, at-rules and selectors", () => {
  const found = slugs(`<style>
    .a > .b:hover { display: flex; gap: 8px; border-top-left-radius: 4px; color: rgba(0,0,0,.5) !important; }
    @media (prefers-color-scheme: dark) { .a { background: url(x.png) } }
  </style>`);
  for (const s of ["css-display-flex", "css-gap", "css-border-radius", "css-rgba", "css-important", "css-selector-child",
    "css-pseudo-class-hover", "css-at-media", "css-at-media-prefers-color-scheme", "css-background-image", "css-unit-px"]) {
    assert.ok(found.includes(s), `missing ${s}`);
  }
});

test("detects inline styles, HTML elements, attributes and image formats", () => {
  const found = slugs(`<!doctype html><table cellpadding="0" align="center"><tr><td style="padding:2rem">
    <h1>Hi</h1><img src="https://x.test/a.webp" alt=""><a href="mailto:a@b.c">m</a><a href="#top">t</a></td></tr></table>`);
  for (const s of ["html-doctype", "html-table", "html-cellpadding", "html-align", "css-padding", "css-unit-rem",
    "html-h1-h6", "html-img", "image-webp", "html-mailto-links", "html-anchor-links"]) {
    assert.ok(found.includes(s), `missing ${s}`);
  }
});

test("Outlook conditional comments are not reported as comments", () => {
  assert.ok(!slugs("<!--[if mso]><table><![endif]-->").includes("html-comments"));
  assert.ok(slugs("<!-- note -->").includes("html-comments"));
});

test("a client with no data for a feature is unknown, not an exception", () => {
  const fake = { stats: { gmail: { android: { "2020-01": "y" } } } };
  assert.equal(supportOn(fake, "thunderbird", "macos").support, "u");
  assert.doesNotThrow(() => checkCompat("<style>.x{table-layout:fixed !important}</style>"));
});

test("latest tested version wins and notes are resolved", () => {
  const f = { stats: { gmail: { android: { "2019-01": "n", "2023-05": "a #1" } } }, notes_by_num: { 1: "Only inline." } };
  assert.deepEqual(supportOn(f, "gmail", "android"), { support: "a", notes: ["Only inline."], version: "2023-05" });
});

test("scores: flex is a known gap in Outlook for Windows, fine in Apple Mail", () => {
  const r = checkCompat("<div style=\"display:flex\">x</div>");
  const outlook = r.clients.find((c) => c.id === "outlook.windows");
  const apple = r.clients.find((c) => c.id === "apple-mail.ios");
  assert.ok(outlook.no.includes("css-display-flex"));
  assert.ok(apple.score > outlook.score);
  assert.ok(listClients().length > 30);
});
