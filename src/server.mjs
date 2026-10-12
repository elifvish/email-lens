/**
 * Local web app: static UI plus a small JSON API. Binds to 127.0.0.1 only. Rejects requests
 * whose Host isn't local (DNS rebinding) and cross-origin calls from other sites: POSTs must
 * be application/json, which browsers won't send cross-origin without a preflight we never
 * answer, and any Origin header must be this server's.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { checkCompat, dataInfo, listClients } from "./compat.mjs";
import { updateData } from "./data.mjs";
import { lint } from "./lint.mjs";
import { closeSessions, createSession, getSession, sessionCount } from "./live.mjs";
import { closeBrowsers, renderAvailable } from "./render.mjs";
import { getMessage, listMessages, parseEml, publicSource, savedSources, SOURCE_TYPES } from "./sources.mjs";
import { PUBLIC_DIR } from "./paths.mjs";
import { DEVICES, MODES } from "../public/variants.js";

const MAX_BODY = 25 * 1024 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".png": "image/png" };

const routes = {
  "GET /api/info": async () => ({
    data: dataInfo(),
    render: await renderAvailable(),
    liveSessions: sessionCount(),
    sources: savedSources().map(publicSource),
    sourceTypes: SOURCE_TYPES,
    clients: listClients(),
    devices: DEVICES,
    modes: MODES,
  }),
  "POST /api/analyze": async ({ html, text = null }) => {
    if (typeof html !== "string" || !html.trim()) throw httpError(400, "Send { html }");
    return { compat: checkCompat(html), lint: lint({ html, text }), bytes: Buffer.byteLength(html) };
  },
  "POST /api/parse": async ({ raw }) => {
    if (typeof raw !== "string" || !raw.trim()) throw httpError(400, "Send { raw } with the .eml source");
    return parseEml(raw);
  },
  "POST /api/sources/list": async ({ source, search, limit }) => ({ messages: await listMessages(source, { search, limit: Math.min(Number(limit) || 50, 200) }) }),
  "POST /api/sources/get": async ({ source, id }) => getMessage(source, id),
  "POST /api/live": async (body) => createSession(body),
  "POST /api/live/close": async ({ ids }) => {
    await closeSessions(Array.isArray(ids) ? ids : undefined);
    return { ok: true };
  },
  "POST /api/update-data": async () => ({ data: await updateData() }),
};

export function startServer({ port = 4600, host = "127.0.0.1" } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const hostHeader = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!["localhost", "127.0.0.1", "[::1]"].includes(hostHeader)) return send(res, 403, { error: "Local access only" });

      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return send(res, 403, { error: "Cross-origin requests are not allowed" });
      if (req.method === "POST" && !/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "Use Content-Type: application/json" });

      const url = new URL(req.url, "http://localhost");
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        const body = req.method === "POST" ? await readJson(req) : {};
        return send(res, 200, await route(body));
      }
      const live = /^\/api\/live\/([0-9a-f-]{36})\/(frame|input|snapshot)$/.exec(url.pathname);
      if (live) return await handleLive(req, res, getSession(live[1]), live[2], url);
      if (req.method !== "GET") return send(res, 404, { error: "Not found" });
      return serveFile(res, PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    } catch (e) {
      send(res, e.status ?? 500, { error: e.message });
    }
  });
  server.listen(port, host, () => console.log(`email-lens running at http://localhost:${port}`));
  const stop = async () => {
    await closeSessions();
    await closeBrowsers();
    process.exit(0);
  };
  // A failed engine call must never take the whole app down.
  process.on("unhandledRejection", (e) => console.error("Unhandled:", e?.message ?? e));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return server;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, "Body too large (25 MB max)");
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw httpError(400, "Invalid JSON");
  }
}

function serveFile(res, root, rel) {
  const path = normalize(join(root, decodeURIComponent(rel)));
  if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) return send(res, 404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(readFileSync(path));
}

async function handleLive(req, res, session, action, url) {
  if (action === "input" && req.method === "POST") {
    await session.input(await readJson(req));
    return send(res, 200, { ok: true });
  }
  if (action === "snapshot" && req.method === "GET") {
    // Straight to the browser; nothing is kept on disk.
    const jpeg = await session.snapshot();
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "Content-Disposition": `inline; filename="${session.device.key}-${session.mode.key}.jpg"` });
    return res.end(jpeg);
  }
  if (action === "frame" && req.method === "GET") {
    const next = await session.nextFrame(Number(url.searchParams.get("v") ?? -1));
    if (!next) {
      res.writeHead(204, { "Cache-Control": "no-store" });
      return res.end();
    }
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store",
      "X-Frame-Version": String(next.version),
      "X-Scroll": `${next.scroll.y},${next.scroll.height},${next.scroll.view}`,
      "X-Links": encodeURIComponent(JSON.stringify(next.links)),
      "X-Error": encodeURIComponent(next.error ?? ""),
    });
    return res.end(next.frame ?? Buffer.alloc(0));
  }
  send(res, 405, { error: "Method not allowed" });
}
