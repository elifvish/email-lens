/**
 * Where emails come from. Each connector lists messages and fetches one as
 * { id, subject, from, to, date, html, text }.
 *
 *   mailpit   { url, username?, password? }            https://mailpit.axllent.org
 *   mailhog   { url, username?, password? }            https://github.com/mailhog/MailHog
 *   mailtrap  { token, accountId, inboxId }            Mailtrap Email Sandbox API
 *
 * Saved connections live in ~/.config/email-lens/sources.json (or $EMAIL_LENS_SOURCES):
 *   [{ "name": "Local Mailpit", "type": "mailpit", "url": "http://localhost:8025" }]
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";

export function savedSources() {
  const file = process.env.EMAIL_LENS_SOURCES ?? join(homedir(), ".config", "email-lens", "sources.json");
  if (!existsSync(file)) return [];
  const list = JSON.parse(readFileSync(file, "utf8"));
  // Secrets stay on the server; the UI refers to a saved source by its index.
  return list.map((s, i) => ({ ...s, savedIndex: i }));
}

export function publicSource(s) {
  const { password, token, ...rest } = s;
  return { ...rest, hasSecret: Boolean(password || token) };
}

/** Resolve what the UI sent: either { savedIndex } or a full inline config. */
export function resolveSource(cfg) {
  if (cfg?.savedIndex != null) {
    const s = savedSources()[cfg.savedIndex];
    if (!s) throw new Error("Unknown saved source");
    return s;
  }
  return cfg;
}

export async function listMessages(cfg, { search = "", limit = 50 } = {}) {
  const c = resolveSource(cfg);
  const impl = CONNECTORS[c.type];
  if (!impl) throw new Error(`Unknown source type "${c.type}"`);
  return impl.list(c, { search, limit });
}

export async function getMessage(cfg, id) {
  const c = resolveSource(cfg);
  const impl = CONNECTORS[c.type];
  if (!impl) throw new Error(`Unknown source type "${c.type}"`);
  return impl.get(c, id);
}

export async function parseEml(raw) {
  const m = await simpleParser(raw);
  let html = m.html || (m.textAsHtml ? `<!doctype html><html><body>${m.textAsHtml}</body></html>` : "");
  // Inline cid: images so previews show them without a mail server.
  for (const a of m.attachments ?? []) {
    if (a.contentId && a.content) {
      const cid = a.contentId.replace(/^<|>$/g, "");
      html = html.split(`cid:${cid}`).join(`data:${a.contentType};base64,${a.content.toString("base64")}`);
    }
  }
  return {
    id: m.messageId ?? null,
    subject: m.subject ?? "(no subject)",
    from: m.from?.text ?? "",
    to: m.to?.text ?? "",
    date: m.date?.toISOString() ?? "",
    html,
    text: m.text ?? "",
  };
}

// ---------------------------------------------------------------------------------------

async function http(url, { headers = {}, as = "json" } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status} ${res.statusText}`);
  return as === "json" ? res.json() : res.text();
}

function basicAuth(c) {
  return c.username ? { Authorization: "Basic " + Buffer.from(`${c.username}:${c.password ?? ""}`).toString("base64") } : {};
}

const trim = (u) => u.replace(/\/+$/, "");

const CONNECTORS = {
  mailpit: {
    async list(c, { search, limit }) {
      const base = `${trim(c.url)}/api/v1`;
      const path = search ? `/search?query=${encodeURIComponent(search)}&limit=${limit}` : `/messages?limit=${limit}`;
      const d = await http(base + path, { headers: basicAuth(c) });
      return (d.messages ?? []).map((m) => ({
        id: m.ID,
        subject: m.Subject,
        from: m.From?.Address ?? "",
        to: (m.To ?? []).map((t) => t.Address).join(", "),
        date: m.Created,
        size: m.Size,
      }));
    },
    async get(c, id) {
      const base = `${trim(c.url)}/api/v1`;
      // The raw source keeps cid: images and every header; parse it like an upload.
      const raw = await http(`${base}/message/${encodeURIComponent(id)}/raw`, { headers: basicAuth(c), as: "text" });
      return { ...(await parseEml(raw)), id };
    },
  },

  mailhog: {
    async list(c, { search, limit }) {
      const base = `${trim(c.url)}/api/v2`;
      const path = search ? `/search?kind=containing&query=${encodeURIComponent(search)}&limit=${limit}` : `/messages?limit=${limit}`;
      const d = await http(base + path, { headers: basicAuth(c) });
      return (d.items ?? []).map((m) => ({
        id: m.ID,
        subject: m.Content?.Headers?.Subject?.[0] ?? "(no subject)",
        from: m.Content?.Headers?.From?.[0] ?? "",
        to: (m.Content?.Headers?.To ?? []).join(", "),
        date: m.Created,
        size: m.Raw?.Data?.length ?? null,
      }));
    },
    async get(c, id) {
      const m = await http(`${trim(c.url)}/api/v1/messages/${encodeURIComponent(id)}`, { headers: basicAuth(c) });
      const headers = Object.entries(m.Content?.Headers ?? {}).flatMap(([k, vs]) => vs.map((v) => `${k}: ${v}`)).join("\r\n");
      return { ...(await parseEml(`${headers}\r\n\r\n${m.Content?.Body ?? ""}`)), id };
    },
  },

  mailtrap: {
    base(c) {
      return `https://mailtrap.io/api/accounts/${encodeURIComponent(c.accountId)}/inboxes/${encodeURIComponent(c.inboxId)}/messages`;
    },
    headers(c) {
      return { "Api-Token": c.token, Accept: "application/json" };
    },
    async list(c, { search, limit }) {
      const q = search ? `?search=${encodeURIComponent(search)}` : "";
      const d = await http(this.base(c) + q, { headers: this.headers(c) });
      return (Array.isArray(d) ? d : []).slice(0, limit).map((m) => ({
        id: String(m.id),
        subject: m.subject,
        from: m.from_email,
        to: m.to_email,
        date: m.created_at,
        size: m.email_size ?? null,
      }));
    },
    async get(c, id) {
      const raw = await http(`${this.base(c)}/${encodeURIComponent(id)}/body.eml`, { headers: this.headers(c), as: "text" });
      return { ...(await parseEml(raw)), id };
    },
  },
};

export const SOURCE_TYPES = Object.keys(CONNECTORS);
