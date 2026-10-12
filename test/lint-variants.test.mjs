import assert from "node:assert/strict";
import { test } from "node:test";
import { lint } from "../src/lint.mjs";
import { applyMode } from "../public/variants.js";

const checks = (html, text) => lint({ html, text }).map((f) => `${f.level}:${f.check}`);

test("flags Gmail clipping over 102 KB", () => {
  assert.ok(checks("<p>" + "x".repeat(110 * 1024) + "</p>").includes("error:size"));
  assert.ok(!checks("<p>small</p>").some((c) => c.endsWith(":size")));
});

test("flags missing alt, local images, scripts and missing plain text", () => {
  const c = checks('<img src="http://localhost/a.png"><script>1</script>', "");
  for (const x of ["warn:alt", "error:local-images", "warn:script", "warn:plain-text"]) assert.ok(c.includes(x), x);
});

test("dark mode variant switches prefers-color-scheme queries", () => {
  const html = "<style>@media (prefers-color-scheme: dark) { a{} } @media (prefers-color-scheme: light) { b{} }</style>";
  assert.match(applyMode(html, "dark"), /\(min-width:0px\) \{ a/);
  assert.match(applyMode(html, "light"), /\(min-width:0px\) \{ b/);
  assert.match(applyMode(html, "dark", { emulatedScheme: true }), /prefers-color-scheme: dark/);
});

test("no-style strips style blocks; no-images blocks images via CSP", () => {
  assert.doesNotMatch(applyMode("<head><style>a{}</style></head><p>x</p>", "no-style"), /<style/);
  assert.match(applyMode("<head></head><img src=a.png>", "no-images"), /img-src 'none'/);
});
