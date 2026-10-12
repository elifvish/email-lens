/**
 * Live engine views: a real WebKit / Chromium / Gecko page per tile, kept open on the server.
 * The UI long-polls for frames and forwards wheel, hover and click input to it.
 *
 * Nothing is written to disk. Frames and snapshots live in memory and go straight to the
 * browser. A session ends when the UI closes it, when nobody has polled it for IDLE_MS, or when
 * the server stops.
 */
import { randomUUID } from "node:crypto";
import { DEVICES, MODES } from "../public/variants.js";
import { openEmailPage, probePage } from "./render.mjs";

const MAX_SESSIONS = 12;
const IDLE_MS = 60_000;
const ACTIVE_MS = 1500; // fast capture this long after the last input
const FAST_INTERVAL = 80;
const IDLE_INTERVAL = 1000;
const POLL_WAIT_MS = 15_000;

const sessions = new Map();

class LiveSession {
  constructor(device, mode, ctx, page) {
    this.id = randomUUID();
    this.device = device;
    this.mode = mode;
    this.ctx = ctx;
    this.page = page;
    this.frame = null;
    this.version = 0;
    this.scroll = { y: 0, height: device.height, view: device.height };
    this.links = [];
    this.waiters = new Set();
    this.lastPoll = Date.now();
    this.activeUntil = Date.now() + ACTIVE_MS;
    this.closed = false;
    this.wake = null;
  }

  /** Clicked links are shown to the user instead of navigating the email away. */
  async interceptLinks() {
    await this.ctx.route("**/*", (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && !req.url().startsWith("about:")) {
        this.links.push(req.url());
        this.kick();
        this.flush();
        return route.abort();
      }
      return route.continue();
    });
    this.ctx.on("page", (p) => p !== this.page && p.close().catch(() => {}));
  }

  async run() {
    while (!this.closed) {
      try {
        const buf = await this.page.screenshot({ type: "jpeg", quality: 72 });
        const s = await this.page.evaluate("[scrollY, document.documentElement.scrollHeight, innerHeight]");
        const changed = !this.frame || !buf.equals(this.frame) || s[0] !== this.scroll.y || s[1] !== this.scroll.height;
        this.scroll = { y: Math.round(s[0]), height: s[1], view: s[2] };
        if (changed) {
          this.frame = buf;
          this.version++;
          this.flush();
        }
      } catch (e) {
        if (this.closed) return;
        this.error = e.message.split("\n")[0];
        this.flush();
      }
      const fast = Date.now() < this.activeUntil;
      await new Promise((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, fast ? FAST_INTERVAL : IDLE_INTERVAL);
      });
    }
  }

  kick() {
    this.activeUntil = Date.now() + ACTIVE_MS;
    this.wake?.();
  }

  flush() {
    for (const w of [...this.waiters]) w();
  }

  /** Resolves with the next frame newer than `since` (or the current one), or null on timeout. */
  async nextFrame(since) {
    this.lastPoll = Date.now();
    if ((this.version > since && this.frame) || this.links.length || this.error) return this.takeFrame();
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, POLL_WAIT_MS);
      this.waiters.add(done);
    });
    this.lastPoll = Date.now();
    return this.version > since || this.links.length || this.error ? this.takeFrame() : null;
  }

  takeFrame() {
    const links = this.links.splice(0);
    return { frame: this.frame, version: this.version, scroll: this.scroll, links, error: this.error ?? null };
  }

  async input({ type, x = 0, y = 0, dx = 0, dy = 0 }) {
    const m = this.page.mouse;
    const px = clamp(x, 0, this.device.width - 1);
    const py = clamp(y, 0, this.device.height - 1);
    // Phones have no hover, and tap instead of click (mobile WebKit rejects mouse input).
    if (type === "move") {
      if (!this.device.mobile) await m.move(px, py);
    }
    else if (type === "wheel") {
      const [sx, sy] = [clamp(dx, -3000, 3000), clamp(dy, -3000, 3000)];
      // Mobile WebKit has no wheel events (phones scroll by touch); scroll the page directly.
      if (this.device.mobile && this.device.engine === "webkit") await this.page.evaluate(`scrollBy(${sx}, ${sy})`);
      else {
        await m.move(px, py);
        await m.wheel(sx, sy);
      }
    } else if (type === "click") await m.click(px, py);
    else if (type === "scrollTo") await this.page.evaluate(`scrollTo(0, ${Math.max(0, Number(y) || 0)})`);
    else throw new Error(`Unknown input "${type}"`);
    this.kick();
  }

  async snapshot() {
    return this.page.screenshot({ type: "jpeg", quality: 85, fullPage: true });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.kick();
    this.flush();
    sessions.delete(this.id);
    await this.ctx.close().catch(() => {});
  }
}

export async function createSession({ html, device: deviceKey, mode: modeKey = "light" }) {
  const device = DEVICES.find((d) => d.key === deviceKey);
  const mode = MODES.find((m) => m.key === modeKey);
  if (!device || !mode) throw Object.assign(new Error("Unknown device or mode"), { status: 400 });
  if (typeof html !== "string" || !html.trim()) throw Object.assign(new Error("Send { html }"), { status: 400 });

  // Over the cap: drop the sessions polled least recently.
  const byAge = [...sessions.values()].sort((a, b) => a.lastPoll - b.lastPoll);
  for (const s of byAge.slice(0, Math.max(0, sessions.size - MAX_SESSIONS + 1))) await s.close();

  const { ctx, page } = await openEmailPage(html, device, mode);
  const session = new LiveSession(device, mode, ctx, page);
  sessions.set(session.id, session);
  const findings = await probePage(page, device, mode).catch(() => []);
  await session.interceptLinks();
  session.run();
  return { id: session.id, device: device.key, engine: device.engine, width: device.width, height: device.height, findings };
}

export function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw Object.assign(new Error("Live view has ended; start it again"), { status: 410 });
  return s;
}

export async function closeSessions(ids = [...sessions.keys()]) {
  await Promise.all(ids.map((id) => sessions.get(id)?.close()));
}

export function sessionCount() {
  return sessions.size;
}

setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  // A poll lasts at most POLL_WAIT_MS, so no poll for IDLE_MS means nobody is watching.
  for (const s of sessions.values()) if (s.lastPoll < cutoff) s.close();
}, 15_000).unref();

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(v) || 0));
}
