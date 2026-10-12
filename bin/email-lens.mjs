#!/usr/bin/env node
/**
 *   email-lens serve [--port 4600]
 *   email-lens check <file.html|file.eml> [--clients gmail.*,outlook.*] [--min-score 80] [--render <dir>] [--json]
 *   email-lens update-data
 *
 * `check` exits 1 when there is an error-level finding or a client scores below --min-score,
 * so it can gate CI.
 */
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { checkCompat } from "../src/compat.mjs";
import { updateData } from "../src/data.mjs";
import { lint } from "../src/lint.mjs";
import { closeBrowsers, render } from "../src/render.mjs";
import { startServer } from "../src/server.mjs";
import { parseEml } from "../src/sources.mjs";

const [command, ...rest] = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const key = rest[i].slice(2);
    opts[key] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  } else positional.push(rest[i]);
}

const KEY_CLIENTS = ["gmail.*", "outlook.*", "apple-mail.*", "yahoo.*", "samsung-email.*", "thunderbird.*"];

switch (command) {
  case "serve":
  case undefined:
    startServer({ port: Number(opts.port ?? process.env.PORT ?? 4600) });
    break;
  case "check":
    // exitCode, not exit(): exit() can cut off piped stdout (e.g. --json) mid-write.
    process.exitCode = await check(positional[0]);
    break;
  case "update-data": {
    const info = await updateData();
    console.log(`caniemail data updated: ${info.features} features, ${info.clients} clients, ${info.updated}`);
    break;
  }
  default:
    console.log(readFileSync(new URL(import.meta.url)).toString().split("*/")[0].replace(/^#!.*\n\/\*\*\n/, "").replace(/^ \* ?/gm, ""));
    process.exit(command === "help" || command === "--help" ? 0 : 2);
}

async function check(file) {
  if (!file) {
    console.error("Usage: email-lens check <file.html|file.eml>");
    return 2;
  }
  const raw = readFileSync(file, "utf8");
  const msg = extname(file).toLowerCase() === ".eml" ? await parseEml(raw) : { subject: file, html: raw, text: null };
  const globs = String(opts.clients ?? KEY_CLIENTS.join(",")).split(",").map((g) => g.trim());
  const match = (id) => globs.some((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(id));

  const compat = checkCompat(msg.html);
  const clients = compat.clients.filter((c) => match(c.id) && c.score != null);
  const findings = lint({ html: msg.html, text: msg.text });
  let renders = null;
  if (opts.render) {
    renders = await render(msg.html, { outDir: resolve(String(opts.render)) });
    await closeBrowsers();
    findings.push(...renders.findings);
  }
  const minScore = opts["min-score"] != null ? Number(opts["min-score"]) : null;
  const below = minScore == null ? [] : clients.filter((c) => c.score < minScore);
  const errors = findings.filter((f) => f.level === "error");

  if (opts.json) {
    console.log(JSON.stringify({ subject: msg.subject, compat: { ...compat, clients }, findings, renders }, null, 2));
  } else {
    const bySlug = new Map(compat.features.map((f) => [f.slug, f]));
    console.log(`\n${msg.subject}  (${(Buffer.byteLength(msg.html) / 1024).toFixed(1)} KB, caniemail data ${compat.data.updated.slice(0, 10)})\n`);
    for (const c of clients.sort((a, b) => a.score - b.score)) {
      const flag = minScore != null && c.score < minScore ? "  ✗" : "";
      const no = c.no.map((s) => bySlug.get(s).title);
      console.log(`  ${String(c.score.toFixed(1)).padStart(5)}%  ${c.name.padEnd(32)}${flag}${no.length ? `  unsupported: ${no.slice(0, 5).join(", ")}${no.length > 5 ? ` +${no.length - 5}` : ""}` : ""}`);
    }
    if (findings.length) console.log("");
    for (const f of findings) {
      console.log(`  ${f.level.toUpperCase().padEnd(5)} ${f.check}: ${f.message}${f.where?.length ? `\n         on ${f.where.join("; ")}` : ""}`);
    }
    if (renders) console.log(`\n  ${renders.shots.length} screenshots in ${resolve(String(opts.render))}`);
    console.log("");
  }
  return errors.length || below.length ? 1 : 0;
}

