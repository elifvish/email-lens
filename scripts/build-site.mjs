/**
 * Build the static demo for GitHub Pages into site/: the app running entirely in the browser
 * (compatibility checks, previews, modes, inspector), plus a page that plays the demo videos.
 *
 *   node scripts/build-site.mjs
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "site");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

cpSync(join(ROOT, "public"), OUT, { recursive: true });
await build({
  entryPoints: [join(ROOT, "src/browser.mjs")],
  outfile: join(OUT, "engine.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  loader: { ".json": "json" },
  legalComments: "none",
});

const index = join(OUT, "index.html");
writeFileSync(index, readFileSync(index, "utf8").replace('<script type="module" src="app.js"></script>', '<script>window.EMAIL_LENS_STATIC = true;</script>\n  <script type="module" src="app.js"></script>'));

const media = join(ROOT, "docs/media");
if (existsSync(media)) {
  cpSync(media, join(OUT, "media"), { recursive: true });
  const clips = readdirSync(media).filter((f) => f.endsWith(".mp4")).sort((a, b) => (a === "tour.mp4" ? -1 : b === "tour.mp4" ? 1 : a.localeCompare(b)));
  const title = (f) => (f === "tour.mp4" ? "Full tour" : f.replace(/^clip-\d-/, "").replace(/\.mp4$/, "").replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()));
  writeFileSync(join(OUT, "videos.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>email-lens videos</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0c0f; color: #ededf2; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; padding: 48px 20px 80px; display: flex; flex-direction: column; gap: 40px; }
  h1 { margin: 0; font-size: 30px; letter-spacing: -0.02em; } p { margin: 6px 0 0; color: #a3a7b3; }
  a { color: #a99bff; } h2 { margin: 0 0 12px; font-size: 18px; }
  video { width: 100%; border-radius: 12px; background: #000; box-shadow: 0 24px 60px rgba(0,0,0,.45); }
</style></head><body><main>
<header><h1>email-lens videos</h1><p>2880×1800 at 60 fps. <a href="./">Try the live demo</a> · <a href="https://github.com/elifvish/email-lens">GitHub</a></p></header>
${clips.map((f) => `<section id="${f.replace(".mp4", "")}"><h2>${title(f)}</h2><video src="media/${f}" controls preload="metadata" playsinline></video></section>`).join("\n")}
</main></body></html>
`);
}
writeFileSync(join(OUT, ".nojekyll"), "");
console.log(`site/ built: ${readdirSync(OUT).join(", ")}`);
