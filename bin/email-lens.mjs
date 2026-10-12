#!/usr/bin/env node
/**
 * email-lens: check HTML emails against ~48 email clients and preview them across devices.
 *
 *   email-lens [serve] [--port 4600] [--host 127.0.0.1] [--open]
 *       Start the local app.
 *
 *   email-lens check <files or globs...> [--clients gmail.*,outlook.*] [--min-score 80]
 *                    [--render <dir>] [--format text|markdown|json]
 *       Check .html / .eml files. Exits 1 on an error-level finding or a client below
 *       --min-score, so it can gate CI. --render also writes real-engine screenshots.
 *
 *   email-lens install-browsers
 *       Download WebKit, Chromium and Firefox for Real engines and --render (about 300 MB).
 *
 *   email-lens update-data
 *       Refresh the bundled caniemail.com dataset.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, extname, join, resolve } from "node:path";
import { checkCompat } from "../src/compat.mjs";
import { updateData } from "../src/data.mjs";
import { lint } from "../src/lint.mjs";
import { parseEml } from "../src/sources.mjs";

const [first, ...rest] = process.argv.slice(2);
const command = !first || first.startsWith("--") ? "serve" : first;
const args = !first || first.startsWith("--") ? process.argv.slice(2) : rest;
const opts = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    opts[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  } else positional.push(args[i]);
}

const KEY_CLIENTS = ["gmail.*", "outlook.*", "apple-mail.*", "yahoo.*", "samsung-email.*", "thunderbird.*"];

switch (command) {
  case "serve": {
    const { startServer } = await import("../src/server.mjs");
    const port = Number(opts.port ?? process.env.PORT ?? 4600);
    startServer({ port, host: opts.host ?? process.env.HOST ?? "127.0.0.1" });
    if (opts.open) openBrowser(`http://localhost:${port}`);
    break;
  }
  case "check":
    // exitCode, not exit(): exit() can cut off piped stdout (e.g. --format json) mid-write.
    process.exitCode = await check(positional);
    break;
  case "install-browsers":
    process.exitCode = installBrowsers();
    break;
  case "update-data": {
    const info = await updateData();
    console.log(`caniemail data updated: ${info.features} features, ${info.clients} clients, ${info.updated}`);
    break;
  }
  case "help":
  case "--help":
  case "-h":
    console.log(usage());
    break;
  default:
    console.error(`Unknown command "${command}".\n\n${usage()}`);
    process.exitCode = 2;
}

function usage() {
  return readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*\n/, "").replace(/^ \* ?/gm, "").trim();
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, argv, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function installBrowsers() {
  let cli;
  try {
    cli = createRequire(import.meta.url).resolve("playwright/cli");
  } catch {
    console.error("Playwright isn't installed (it's an optional dependency). Reinstall without --omit=optional.");
    return 1;
  }
  return spawnSync(process.execPath, [cli, "install", "chromium", "webkit", "firefox"], { stdio: "inherit" }).status ?? 1;
}

/** Expand files, directories and globs into a sorted list of .html/.htm/.eml files. */
function expand(patterns) {
  const files = new Set();
  for (const p of patterns) {
    if (existsSync(p) && statSync(p).isDirectory()) {
      for (const f of globSync(join(p, "**/*.{html,htm,eml}"))) files.add(f);
    } else if (/[*?{[]/.test(p)) {
      for (const f of globSync(p)) files.add(f);
    } else files.add(p);
  }
  return [...files].filter((f) => /\.(html?|eml)$/i.test(f)).sort();
}

async function check(patterns) {
  const files = expand(patterns);
  if (!files.length) {
    console.error(patterns.length ? `No .html/.eml files matched: ${patterns.join(" ")}` : "Usage: email-lens check <files or globs...>");
    return 2;
  }
  const format = opts.json ? "json" : String(opts.format ?? "text");
  const globs = String(opts.clients ?? KEY_CLIENTS.join(",")).split(",").map((g) => g.trim());
  const match = (id) => globs.some((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(id));
  const minScore = opts["min-score"] != null ? Number(opts["min-score"]) : null;

  const results = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const msg = extname(file).toLowerCase() === ".eml" ? await parseEml(raw) : { subject: basename(file), html: raw, text: null };
    const compat = checkCompat(msg.html);
    const clients = compat.clients.filter((c) => match(c.id) && c.score != null).sort((a, b) => a.score - b.score);
    const findings = lint({ html: msg.html, text: msg.text });
    let renders = null;
    if (opts.render) {
      const { render } = await import("../src/render.mjs");
      const outDir = resolve(String(opts.render), files.length > 1 ? basename(file).replace(/\.[^.]+$/, "") : "");
      renders = { ...(await render(msg.html, { outDir })), outDir };
      findings.push(...renders.findings);
    }
    const below = minScore == null ? [] : clients.filter((c) => c.score < minScore);
    const errors = findings.filter((f) => f.level === "error");
    results.push({ file, subject: msg.subject, bytes: new TextEncoder().encode(msg.html).length, compat, clients, findings, renders, below, failed: errors.length > 0 || below.length > 0 });
  }
  if (opts.render) await (await import("../src/render.mjs")).closeBrowsers();

  if (format === "json") {
    console.log(JSON.stringify(results.map(({ compat, ...r }) => ({ ...r, overall: compat.overall, data: compat.data, features: compat.features })), null, 2));
  } else if (format === "markdown") {
    console.log(markdown(results, minScore));
  } else {
    for (const r of results) printText(r, minScore);
  }
  return results.some((r) => r.failed) ? 1 : 0;
}

function printText(r, minScore) {
  const bySlug = new Map(r.compat.features.map((f) => [f.slug, f]));
  console.log(`\n${r.file}  (${(r.bytes / 1024).toFixed(1)} KB, caniemail data ${r.compat.data.updated.slice(0, 10)})\n`);
  for (const c of r.clients) {
    const flag = minScore != null && c.score < minScore ? "  ✗" : "";
    const no = c.no.map((s) => bySlug.get(s).title);
    console.log(`  ${String(c.score.toFixed(1)).padStart(5)}%  ${c.name.padEnd(32)}${flag}${no.length ? `  unsupported: ${no.slice(0, 5).join(", ")}${no.length > 5 ? ` +${no.length - 5}` : ""}` : ""}`);
  }
  if (r.findings.length) console.log("");
  for (const f of r.findings) {
    console.log(`  ${f.level.toUpperCase().padEnd(5)} ${f.check}: ${f.message}${f.where?.length ? `\n         on ${f.where.join("; ")}` : ""}`);
  }
  if (r.renders) console.log(`\n  ${r.renders.shots.length} screenshots in ${r.renders.outDir}`);
  console.log("");
}

/** Markdown-safe text: tags in messages ("<style>") must show as text, and pipes would break tables. */
function md(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|");
}

/** A report for CI summaries and PR comments. */
function markdown(results, minScore) {
  const icon = (r) => (r.failed ? "❌" : r.findings.some((f) => f.level === "warn") ? "⚠️" : "✅");
  const out = ["## email-lens report", ""];
  out.push("| | Email | Avg. support | Lowest client | Errors | Warnings | Size |", "|---|---|---|---|---|---|---|");
  for (const r of results) {
    const worst = r.clients[0];
    const count = (lvl) => r.findings.filter((f) => f.level === lvl).length;
    out.push(`| ${icon(r)} | \`${r.file}\` | ${r.compat.overall?.toFixed(0) ?? "–"}% | ${worst ? `${worst.name} ${worst.score.toFixed(0)}%` : "–"} | ${count("error")} | ${count("warn")} | ${(r.bytes / 1024).toFixed(1)} KB |`);
  }
  for (const r of results) {
    const bySlug = new Map(r.compat.features.map((f) => [f.slug, f]));
    out.push("", `<details${r.failed ? " open" : ""}><summary><b>${r.file}</b></summary>`, "");
    const issues = r.findings.filter((f) => f.level !== "info");
    if (issues.length) {
      out.push("**Issues**", "");
      for (const f of issues) out.push(`- ${f.level === "error" ? "🔴" : "🟡"} **${f.check}**: ${md(f.message)}${f.where?.length ? ` _(${md(f.where.join("; "))})_` : ""}`);
      out.push("");
    }
    out.push("| Client | Support | Unsupported |", "|---|---|---|");
    for (const c of r.clients) {
      const flag = minScore != null && c.score < minScore ? " ❌" : "";
      const no = c.no.map((s) => bySlug.get(s).title);
      out.push(`| ${c.name} | ${c.score.toFixed(0)}%${flag} | ${md(no.slice(0, 6).join(", "))}${no.length > 6 ? ` +${no.length - 6}` : ""} |`);
    }
    out.push("", "</details>");
  }
  out.push("", `<sub>caniemail data ${results[0].compat.data.updated.slice(0, 10)} · [email-lens](https://github.com/elifvish/email-lens)</sub>`);
  return out.join("\n");
}
