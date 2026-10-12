import { layoutProbe } from "./probe.js";
import { applyMode, DEVICES, MODES } from "./variants.js";

// ---------------------------------------------------------------------------------------
// Constants

const KEY_FAMILIES = ["gmail", "outlook", "apple-mail", "yahoo", "samsung-email", "thunderbird", "aol", "protonmail"];
const PROBED_MODES = ["light", "dark", "no-style"];
const MODE_NOTES = {
  light: "",
  dark: "The email's own dark-mode styles, as Apple Mail and iOS Mail apply them.",
  "forced-dark": "Simulates the Gmail and Outlook apps, which invert emails that don't handle dark mode. Watch for logos and text that disappear.",
  "no-style": "Embedded <style> removed, as Gmail does for non-Google accounts. Only inline styles survive.",
  "no-images": "Images blocked, the default in Outlook and many work inboxes. Alt text and background colours carry the message.",
};
/** How each device is framed on the stage. */
const FRAMES = {
  "iphone-se": { kind: "phone", cutout: "island" },
  iphone: { kind: "phone", cutout: "island" },
  android: { kind: "phone", cutout: "punch" },
  ipad: { kind: "tablet" },
  desktop: { kind: "laptop", chrome: "url", label: "mail.example.com" },
  thunderbird: { kind: "window", chrome: "title", label: "Inbox — Mail" },
};
const STORE = { connections: "email-lens.connections", tweaks: "email-lens.tweaks", devices: "email-lens.devices" };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const stripTags = (s) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** caniemail notes mix Markdown links, backtick-quoted tags and a little HTML; make them plain text. */
const noteText = (n) =>
  stripTags(
    String(n ?? "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]*)`/g, (_, code) => code.replace(/</g, "\u0001").replace(/>/g, "\u0002")),
  )
    .replace(/\u0001/g, "<")
    .replace(/\u0002/g, ">");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tone = (score) => (score == null ? "" : score >= 90 ? "good" : score >= 75 ? "warn" : "bad");
const toneColor = (score) => `var(--${tone(score) || "faint"})`;

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private window): settings last for this session only */
  }
}

const state = {
  info: null,
  email: null,
  analysis: null,
  renderer: "preview",
  mode: "light",
  devices: new Set(load(STORE.devices, ["iphone", "ipad", "desktop"]).filter((k) => DEVICES.some((d) => d.key === k))),
  previewFindings: new Map(), // `${device}|${mode}` → findings
  liveFindings: new Map(), // device → findings
  tiles: new Map(), // device → live tile
  connection: null,
  tweaks: { frames: "real", stage: "dots", size: "fit", ...load(STORE.tweaks, {}) },
};
if (!state.devices.size) state.devices = new Set(["iphone", "ipad", "desktop"]);

// ---------------------------------------------------------------------------------------
// Plumbing

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast${isError ? " error" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2400);
}

function mergeFindings(list) {
  const map = new Map();
  for (const f of list) {
    const key = `${f.level}|${f.check}|${f.message}`;
    const hit = map.get(key) ?? { ...f, where: [] };
    for (const w of Array.isArray(f.where) ? f.where : f.where ? [f.where] : []) if (!hit.where.includes(w)) hit.where.push(w);
    map.set(key, hit);
  }
  const order = { error: 0, warn: 1, info: 2 };
  return [...map.values()].sort((a, b) => order[a.level] - order[b.level]);
}

function allFindings() {
  if (!state.analysis) return [];
  return mergeFindings([...state.analysis.lint, ...[...state.previewFindings.values()].flat(), ...[...state.liveFindings.values()].flat()]);
}

// ---------------------------------------------------------------------------------------
// Startup

async function init() {
  applyTweaks();
  setupChrome();
  setupSheet();
  setupDock();
  setupInspector();
  setupDragDrop();
  setupKeys();
  try {
    state.info = await api("/api/info");
  } catch (e) {
    toast(`Can't reach the email-lens server: ${e.message}`, true);
    return;
  }
  setupInbox();
  const live = $('[data-renderer="live"]');
  if (!state.info.render.available) {
    live.disabled = true;
    live.title = "Install the engines with `npm run browsers`, then restart the server";
  }
  window.addEventListener("resize", debounce(fitDevices, 120));
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function setupChrome() {
  $("#open-btn").addEventListener("click", () => openSheet("paste"));
  $("#title-btn").addEventListener("click", () => openSheet("paste"));
  $("#verdict").addEventListener("click", () => toggleInspector(true, "overview"));
  for (const b of $$("[data-open]")) b.addEventListener("click", () => openSheet(b.dataset.open));
  for (const b of $$("[data-sample]")) b.addEventListener("click", () => loadSample(b.dataset.sample, b.textContent.trim()));

  $("#tweaks-btn").addEventListener("click", () => {
    const panel = $("#tweaks-panel");
    panel.hidden = !panel.hidden;
    $("#tweaks-btn").setAttribute("aria-expanded", String(!panel.hidden));
  });
  for (const group of $$("[data-tweak]")) {
    for (const b of $$("button", group)) {
      b.addEventListener("click", () => {
        state.tweaks[group.dataset.tweak] = b.dataset.value;
        save(STORE.tweaks, state.tweaks);
        applyTweaks();
        fitDevices();
      });
    }
  }
}

function applyTweaks() {
  document.body.dataset.frames = state.tweaks.frames;
  document.body.dataset.stage = state.tweaks.stage;
  for (const group of $$("[data-tweak]")) {
    for (const b of $$("button", group)) b.setAttribute("aria-pressed", String(state.tweaks[group.dataset.tweak] === b.dataset.value));
  }
}

function setupKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "o") {
      e.preventDefault();
      openSheet("paste");
    } else if (e.key === "i" && state.email) toggleInspector();
    else if (e.key === "Escape") toggleInspector(false);
    else if (/^[1-5]$/.test(e.key) && state.email) setMode(MODES[Number(e.key) - 1].key);
  });
}

// ---------------------------------------------------------------------------------------
// Loading emails

function looksLikeEml(text) {
  const head = text.slice(0, 4000);
  return !/^\s*</.test(text) && /^[A-Za-z-]+:\s.*$/m.test(head.split(/\r?\n\r?\n/)[0]) && /^(mime-version|content-type|received|from|subject):/im.test(head);
}

async function loadText(text, name) {
  if (looksLikeEml(text)) return loadEmail(await api("/api/parse", { raw: text }));
  return loadEmail({ subject: name, html: text, text: null });
}

async function loadSample(key, name) {
  try {
    const html = await fetch(`samples/${key}.html`).then((r) => r.text());
    $("#paste-input").value = html;
    $("#paste-input").scrollTop = 0;
    await loadEmail({ subject: name, html, text: null });
  } catch (e) {
    toast(e.message, true);
  }
}

async function loadFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    if (/\.eml$/i.test(file.name) || looksLikeEml(text)) await loadEmail(await api("/api/parse", { raw: text }));
    else await loadEmail({ subject: file.name, html: text, text: null });
  } catch (e) {
    toast(e.message, true);
  }
}

async function loadEmail(email) {
  if (!email.html?.trim()) throw new Error("This message has no HTML part");
  await stopLive();
  state.email = email;
  state.previewFindings = new Map();
  state.liveFindings = new Map();
  state.analysis = await api("/api/analyze", { html: email.html, text: email.text ?? null });
  $("#sheet").close();
  $("#empty").hidden = true;
  $("#devices").hidden = false;
  $("#dock").hidden = false;
  $("#title-btn").hidden = false;
  $("#title-text").textContent = email.subject || "(no subject)";
  $("#open-btn").hidden = false;
  renderDevices();
  renderInspector();
}

// ---------------------------------------------------------------------------------------
// Stage: device frames

function frameMarkup(device, frame) {
  const status = (big) => `<div class="statusbar"><span>9:41</span><span class="sb-icons">
      <i style="width:${big ? 17 : 14}px;height:${big ? 10 : 8}px"></i><i style="width:${big ? 24 : 20}px;height:${big ? 11 : 9}px;border-radius:3px"></i></span></div>`;
  if (frame.kind === "phone") {
    const cutout = frame.cutout === "island" ? '<span class="island"></span>' : '<span class="punch"></span>';
    return `<div class="frame frame-phone">${cutout}<div class="screen">${status(true)}<div class="viewport"></div></div><span class="homebar"></span></div>`;
  }
  if (frame.kind === "tablet") return `<div class="frame frame-tablet"><div class="screen">${status(false)}<div class="viewport"></div></div></div>`;
  const chrome = frame.chrome === "url"
    ? `<div class="chrome"><span class="lights"><i></i><i></i><i></i></span><span class="url">${esc(frame.label)}</span><span style="width:52px"></span></div>`
    : `<div class="chrome"><span class="lights"><i></i><i></i><i></i></span><span class="title">${esc(frame.label)}</span><span style="width:52px"></span></div>`;
  const base = frame.kind === "laptop" ? '<span class="base"></span>' : "";
  return `<div class="frame frame-${frame.kind}"><div class="screen">${chrome}<div class="viewport"></div></div>${base}</div>`;
}

function renderDevices() {
  const container = $("#devices");
  container.innerHTML = "";
  const darkChrome = state.mode === "dark" || state.mode === "forced-dark";
  for (const device of DEVICES.filter((d) => state.devices.has(d.key))) {
    const el = document.createElement("div");
    el.className = "device";
    el.dataset.device = device.key;
    el.innerHTML = `${frameMarkup(device, FRAMES[device.key])}
      <div class="device-label">
        <div class="dl-top"><span class="dot"></span><strong>${esc(device.label)}</strong><span class="issue-slot"></span></div>
        <div class="dl-meta"><span>${device.width}px · ${state.renderer === "live" ? esc(device.engine) : "preview"}</span><span class="device-tools"></span></div>
      </div>`;
    $(".screen", el).classList.toggle("screen-dark", darkChrome);
    const viewport = $(".viewport", el);
    viewport.style.width = `${device.width}px`;
    viewport.style.height = `${device.height}px`;
    viewport.style.position = "relative";
    container.append(el);
    if (state.renderer === "preview") mountPreview(el, device);
    else mountLive(el, device);
  }
  updateModeNote();
  fitDevices();
}

/** One zoom for every frame so relative sizes stay true, fitted to the stage height. */
function fitDevices() {
  const frames = $$("#devices .device");
  if (!frames.length) return;
  for (const el of frames) $(".frame", el).style.zoom = "";
  if (state.tweaks.size === "actual") return;
  const stage = $("#stage");
  const gap = parseFloat(getComputedStyle($("#devices")).columnGap) || 0;
  const availableH = stage.clientHeight - 84 - 132 - 40;
  // On phone-sized windows the row scrolls sideways instead of shrinking every frame to fit.
  const narrow = stage.clientWidth < 760;
  const availableW = narrow ? Infinity : stage.clientWidth - (parseFloat(getComputedStyle($("#devices")).paddingLeft) * 2 || 176) - gap * (frames.length - 1);
  const tallest = Math.max(...frames.map((el) => $(".frame", el).offsetHeight + 18));
  // The laptop's base sticks out 64px on each side.
  const totalWidth = frames.reduce((n, el) => n + $(".frame", el).offsetWidth + ($(".base", el) ? 128 : 0), 0);
  const zoom = Math.max(0.2, Math.min(1, availableH / tallest, availableW / totalWidth));
  for (const el of frames) $(".frame", el).style.zoom = String(zoom);
  // Labels can be wider than a small frame; shrink until the whole row fits the stage.
  const row = $("#devices");
  for (let i = 0, z = zoom; !narrow && i < 4 && row.scrollWidth > stage.clientWidth + 1 && z > 0.2; i++) {
    z = Math.max(0.2, z * (stage.clientWidth / row.scrollWidth) * 0.98);
    for (const el of frames) $(".frame", el).style.zoom = String(z);
  }
}

function setIssueBadge(el, findings) {
  const slot = $(".issue-slot", el);
  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  if (!errors && !warns) {
    slot.innerHTML = `<button type="button" class="issue tone-good" title="No layout problems on this device">OK</button>`;
  } else {
    const n = errors || warns;
    const word = errors ? (n > 1 ? "errors" : "error") : n > 1 ? "warnings" : "warning";
    slot.innerHTML = `<button type="button" class="issue tone-${errors ? "bad" : "warn"}" title="${esc(findings.map((f) => `${f.check}: ${f.message}`).join("\n"))}">${n} ${word}</button>`;
  }
  $("button", slot).addEventListener("click", () => toggleInspector(true, "issues"));
}

// --- Preview renderer (iframes in this browser) ----------------------------------------

function mountPreview(el, device) {
  const iframe = document.createElement("iframe");
  iframe.title = `${device.label} preview`;
  // No allow-scripts: like every email client, the email's scripts never run.
  iframe.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
  iframe.style.width = `${device.width}px`;
  iframe.style.height = `${device.height}px`;
  const html = applyMode(state.email.html, state.mode);
  iframe.srcdoc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}<base target="_blank">`) : `<base target="_blank">${html}`;
  iframe.addEventListener("load", () => {
    if (!PROBED_MODES.includes(state.mode)) return $(".issue-slot", el).replaceChildren();
    let issues = [];
    try {
      issues = layoutProbe(iframe.contentWindow, { mobile: device.mobile, mode: state.mode, screenWidth: device.width });
    } catch (e) {
      console.warn("probe failed", e);
    }
    const where = `${device.label}, ${MODES.find((m) => m.key === state.mode).label} (preview)`;
    state.previewFindings.set(`${device.key}|${state.mode}`, issues.map((i) => ({ ...i, where })));
    setIssueBadge(el, issues);
    renderVerdict();
  });
  $(".viewport", el).append(iframe);
}

// --- Live renderer (real engines on the server, streamed) -------------------------------

function mountLive(el, device) {
  const viewport = $(".viewport", el);
  viewport.innerHTML = `<img class="stream" alt="" draggable="false"><div class="screen-overlay"><span><span class="spinner"></span>Starting ${esc(device.engine)}…</span></div>`;
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "img");
  viewport.setAttribute("aria-label", `${device.label} in ${device.engine}. Arrow keys, Page Up/Down, Home and End scroll.`);
  $(".device-tools", el).innerHTML = `
    <button type="button" class="icon-btn" data-act="top" title="Scroll to top"><svg><use href="#i-top"/></svg></button>
    <button type="button" class="icon-btn" data-act="snap" title="Full-length snapshot in a new tab (not saved)"><svg><use href="#i-camera"/></svg></button>`;
  const tile = { device, el, id: null, version: -1, abort: new AbortController(), closed: false, queue: Promise.resolve(), url: null };
  state.tiles.set(device.key, tile);
  startTile(tile);
}

async function startTile(tile) {
  try {
    const r = await api("/api/live", { html: state.email.html, device: tile.device.key, mode: state.mode });
    tile.id = r.id;
    if (tile.closed) return closeOnServer([r.id]);
    state.liveFindings.set(tile.device.key, r.findings);
    if (PROBED_MODES.includes(state.mode)) setIssueBadge(tile.el, r.findings);
    renderVerdict();
    renderIssues();
    bindTileInput(tile);
    pollTile(tile);
  } catch (e) {
    $(".screen-overlay", tile.el).textContent = `Couldn't start ${tile.device.engine}: ${e.message}`;
  }
}

async function stopLive() {
  const tiles = [...state.tiles.values()];
  state.tiles.clear();
  for (const t of tiles) {
    t.closed = true;
    t.abort.abort();
    if (t.url) URL.revokeObjectURL(t.url);
  }
  const ids = tiles.map((t) => t.id).filter(Boolean);
  if (ids.length) await closeOnServer(ids);
}

function closeOnServer(ids) {
  return api("/api/live/close", { ids }).catch(() => {});
}

async function pollTile(tile) {
  const img = $("img.stream", tile.el);
  const overlay = $(".screen-overlay", tile.el);
  const dot = $(".device-label .dot", tile.el);
  img.addEventListener("load", () => {
    if (tile.previousUrl) URL.revokeObjectURL(tile.previousUrl);
    tile.previousUrl = null;
  });
  while (!tile.closed) {
    let res;
    try {
      res = await fetch(`/api/live/${tile.id}/frame?v=${tile.version}`, { signal: tile.abort.signal, cache: "no-store" });
    } catch {
      if (tile.closed) return;
      dot.classList.remove("live");
      await sleep(1000);
      continue;
    }
    if (res.status === 204) continue;
    if (!res.ok) {
      dot.classList.remove("live");
      overlay.hidden = false;
      overlay.innerHTML = `<span>This live view ended. <button type="button" class="btn btn-sm">Restart</button></span>`;
      $("button", overlay).addEventListener("click", () => renderDevices());
      return;
    }
    const blob = await res.blob();
    tile.version = Number(res.headers.get("X-Frame-Version"));
    const links = JSON.parse(decodeURIComponent(res.headers.get("X-Links") || "%5B%5D"));
    if (links.length) showLink(tile, links.at(-1));
    const error = decodeURIComponent(res.headers.get("X-Error") || "");
    if (blob.size) {
      tile.previousUrl = tile.url;
      tile.url = URL.createObjectURL(blob);
      img.src = tile.url;
      overlay.hidden = !error;
      dot.classList.add("live");
    }
    if (error) {
      overlay.hidden = false;
      overlay.textContent = error;
    }
  }
}

function showLink(tile, url) {
  const viewport = $(".viewport", tile.el);
  $(".link-note", viewport)?.remove();
  const note = document.createElement("div");
  note.className = "link-note";
  note.innerHTML = `Link clicked: ${/^https?:\/\//i.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : esc(url)}`;
  viewport.append(note);
  setTimeout(() => note.remove(), 6000);
}

function bindTileInput(tile) {
  const { device } = tile;
  const viewport = $(".viewport", tile.el);
  const send = (body) => {
    tile.queue = tile.queue.then(() =>
      fetch(`/api/live/${tile.id}/input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {}),
    );
  };
  const ratio = () => device.width / viewport.getBoundingClientRect().width;
  const point = (e) => {
    const r = viewport.getBoundingClientRect();
    return { x: (e.clientX - r.left) * ratio(), y: (e.clientY - r.top) * ratio() };
  };
  let wheel = null;
  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? device.height : 1;
      if (!wheel) {
        wheel = { type: "wheel", dx: 0, dy: 0, ...point(e) };
        setTimeout(() => {
          send(wheel);
          wheel = null;
        }, 40);
      }
      wheel.dx += e.deltaX * unit * ratio();
      wheel.dy += e.deltaY * unit * ratio();
    },
    { passive: false },
  );
  let lastMove = 0;
  viewport.addEventListener("mousemove", (e) => {
    if (Date.now() - lastMove < 120) return;
    lastMove = Date.now();
    send({ type: "move", ...point(e) });
  });
  viewport.addEventListener("click", (e) => {
    if (e.target.closest(".link-note")) return;
    viewport.focus({ preventScroll: true });
    send({ type: "click", ...point(e) });
  });
  viewport.addEventListener("keydown", (e) => {
    const page = device.height * 0.85;
    const steps = { ArrowDown: 60, ArrowUp: -60, PageDown: page, PageUp: -page, " ": e.shiftKey ? -page : page };
    if (e.key in steps) {
      e.preventDefault();
      send({ type: "wheel", dx: 0, dy: steps[e.key], x: device.width / 2, y: device.height / 2 });
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      send({ type: "scrollTo", y: e.key === "Home" ? 0 : 1e7 });
    }
  });
  $('[data-act="top"]', tile.el).addEventListener("click", () => send({ type: "scrollTo", y: 0 }));
  $('[data-act="snap"]', tile.el).addEventListener("click", () => window.open(`/api/live/${tile.id}/snapshot`, "_blank", "noopener"));
}

// ---------------------------------------------------------------------------------------
// Dock

function setupDock() {
  $("#mode-seg").innerHTML = MODES.map((m, i) => `<button type="button" role="radio" data-mode="${m.key}" aria-checked="${m.key === state.mode}" title="${esc(m.label)} (${i + 1})">${esc(m.label)}</button>`).join("");
  for (const b of $$("[data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode));
  for (const b of $$("[data-renderer]")) b.addEventListener("click", () => setRenderer(b.dataset.renderer));

  const pop = $("#devices-pop");
  const btn = $("#devices-btn");
  const renderPop = () => {
    pop.innerHTML = DEVICES.map(
      (d) => `<button type="button" class="pop-item" role="menuitemcheckbox" data-device="${d.key}" aria-checked="${state.devices.has(d.key)}">
        <span class="check"></span><span class="name">${esc(d.label)}</span><span class="meta">${d.width}px · ${esc(d.engine)}</span></button>`,
    ).join("");
    for (const item of $$(".pop-item", pop)) {
      item.addEventListener("click", () => {
        const k = item.dataset.device;
        if (state.devices.has(k) && state.devices.size > 1) state.devices.delete(k);
        else state.devices.add(k);
        save(STORE.devices, [...state.devices]);
        renderPop();
        updateDevicesCount();
        if (state.email) {
          stopLive().then(renderDevices);
        }
      });
    }
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    btn.setAttribute("aria-expanded", String(!pop.hidden));
    if (!pop.hidden) renderPop();
  });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !e.target.closest(".pop-anchor")) {
      pop.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
  });
  $("#inspect-btn").addEventListener("click", () => toggleInspector());
  updateDevicesCount();
  // Leaving the page ends every live session right away instead of waiting for the idle timeout.
  window.addEventListener("pagehide", () => {
    const ids = [...state.tiles.values()].map((t) => t.id).filter(Boolean);
    if (ids.length) fetch("/api/live/close", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
  });
}

function updateDevicesCount() {
  $("#devices-count").textContent = `${state.devices.size} device${state.devices.size > 1 ? "s" : ""}`;
}

async function setMode(mode) {
  state.mode = mode;
  $$("[data-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  if (!state.email) return;
  await stopLive();
  state.liveFindings = new Map();
  renderDevices();
  renderVerdict();
}

async function setRenderer(renderer) {
  if (renderer === state.renderer) return;
  state.renderer = renderer;
  $$("[data-renderer]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.renderer === renderer)));
  if (!state.email) return;
  await stopLive();
  renderDevices();
}

function updateModeNote() {
  const note = $("#mode-note");
  note.textContent = MODE_NOTES[state.mode] + (state.renderer === "live" ? (MODE_NOTES[state.mode] ? " " : "") + "Scroll and click inside a screen; links are shown, not followed." : "");
  note.hidden = !note.textContent;
}

// ---------------------------------------------------------------------------------------
// Inspector

function setupInspector() {
  $("#insp-close").addEventListener("click", () => toggleInspector(false));
  for (const b of $$("[data-tab]")) b.addEventListener("click", () => selectTab(b.dataset.tab));
  $("#clients-all").addEventListener("change", renderClients);
  $("#features-all").addEventListener("change", renderFeatures);
  $("#features-filter").addEventListener("input", renderFeatures);
  $("#copy-code").addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.email.html);
    toast("HTML copied");
  });
}

function toggleInspector(open = $("#inspector").hidden, tab) {
  if (!state.email && open) return;
  $("#inspector").hidden = !open;
  document.body.classList.toggle("inspecting", open);
  $("#inspect-btn").setAttribute("aria-pressed", String(open));
  if (tab) selectTab(tab);
  requestAnimationFrame(fitDevices);
}

function selectTab(key) {
  $$("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === key)));
  $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== key));
}

function renderInspector() {
  renderVerdict();
  renderClients();
  renderFeatures();
  $("#code").textContent = state.email.html;
  $("#code-size").textContent = `${(state.analysis.bytes / 1024).toFixed(1)} KB · ${state.analysis.compat.features.length} HTML/CSS features`;
}

function keyClients() {
  return state.analysis.compat.clients.filter((c) => KEY_FAMILIES.includes(c.family) && c.score != null).sort((a, b) => a.score - b.score);
}

/** Header chip, dock badge, overview and issues all read from the same findings. */
function renderVerdict() {
  if (!state.analysis) return;
  const findings = allFindings();
  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  const overall = state.analysis.compat.overall;
  const score = overall == null ? null : Math.round(overall);

  $("#verdict").hidden = false;
  const chip = $("#verdict-score");
  chip.textContent = score ?? "–";
  chip.className = `verdict-score tone-${tone(score)}`;
  $("#verdict-text").textContent = errors || warns ? [errors && `${errors} error${errors > 1 ? "s" : ""}`, warns && `${warns} warning${warns > 1 ? "s" : ""}`].filter(Boolean).join(" · ") : "No issues";

  const count = $("#inspect-count");
  count.hidden = !(errors || warns);
  count.textContent = errors || warns;
  count.className = `count tone-${errors ? "bad" : "warn"}`;

  renderOverview(findings, errors, warns, score);
  renderIssues();
}

function renderOverview(findings, errors, warns, score) {
  const clients = keyClients();
  const worst = clients[0];
  const circumference = 2 * Math.PI * 36;
  let headline;
  if (errors) headline = "Breaks on some screens";
  else if (!worst || worst.score >= 85) headline = "Holds up everywhere";
  else if (worst.score >= 70) headline = "Solid, with a few gaps";
  else headline = "Holds up in most clients";
  const detail = [
    worst ? `${worst.name} supports ${Math.round(worst.score)}% of what this email uses.` : "",
    errors ? `${errors} layout or content error${errors > 1 ? "s" : ""} to fix.` : warns ? `${warns} thing${warns > 1 ? "s" : ""} worth a look.` : "No layout problems found on the screens checked.",
  ].join(" ");
  const top = findings.filter((f) => f.level !== "info").slice(0, 3);

  $('[data-panel="overview"]').innerHTML = `
    <div class="ov-score">
      <div class="ring">
        <svg viewBox="0 0 84 84"><circle cx="42" cy="42" r="36" fill="none" stroke="var(--surface-3)" stroke-width="7"/>
          <circle cx="42" cy="42" r="36" fill="none" stroke="${toneColor(score)}" stroke-width="7" stroke-linecap="round"
            stroke-dasharray="${circumference}" stroke-dashoffset="${circumference * (1 - (score ?? 0) / 100)}"/></svg>
        <b>${score ?? "–"}</b>
      </div>
      <div class="ov-verdict"><h2>${esc(headline)}</h2><p>${esc(detail)}</p></div>
    </div>
    <div class="ov-stats">
      <div class="ov-stat"><b style="color:${errors ? "var(--bad)" : "var(--ink)"}">${errors}</b><span>errors</span></div>
      <div class="ov-stat"><b style="color:${warns ? "var(--warn)" : "var(--ink)"}">${warns}</b><span>warnings</span></div>
      <div class="ov-stat"><b>${(state.analysis.bytes / 1024).toFixed(0)}<small style="font-size:13px;color:var(--faint)"> KB</small></b><span>of 102 KB before Gmail clips</span></div>
    </div>
    <div class="section-title">Lowest support<button class="link-btn" type="button" data-goto="clients">All clients</button></div>
    <div>${clients.slice(0, 5).map(clientRow).join("")}</div>
    <div class="section-title">${top.length ? "Top issues" : "Issues"}<button class="link-btn" type="button" data-goto="issues">All issues</button></div>
    ${top.length ? top.map(findingHtml).join("") : `<p class="empty-line ok-line">Nothing to fix on the screens and modes checked so far.</p>`}`;
  for (const b of $$('[data-panel="overview"] [data-goto]')) b.addEventListener("click", () => selectTab(b.dataset.goto));
  bindClientRows($('[data-panel="overview"]'));
}

function clientRow(c) {
  return `<button type="button" class="client-row" data-client="${esc(c.id)}" aria-expanded="false">
    <span class="cname">${esc(c.name)}</span>
    <span class="cbar"><i style="width:${c.score ?? 0}%;background:${toneColor(c.score)}"></i></span>
    <span class="score" style="color:${toneColor(c.score)}">${c.score == null ? "–" : Math.round(c.score) + "%"}</span>
  </button>`;
}

function clientDetail(c) {
  const byFeature = new Map(state.analysis.compat.features.map((f) => [f.slug, f]));
  const items = [...c.no.map((s) => ["n", s]), ...c.partial.map((s) => ["a", s])];
  if (!items.length) return `<div class="client-detail"><span class="ok-line">Supports everything this email uses.</span></div>`;
  return `<div class="client-detail"><ul>${items
    .map(([lvl, slug]) => {
      const f = byFeature.get(slug);
      const notes = f.support[c.id].notes.map((n) => `<span class="note">${esc(noteText(n))}</span>`).join("");
      return `<li><span class="sdot ${lvl}"></span><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.title)}</a>${notes}</li>`;
    })
    .join("")}</ul></div>`;
}

function bindClientRows(root) {
  for (const row of $$(".client-row", root)) {
    row.addEventListener("click", () => {
      const open = row.getAttribute("aria-expanded") === "true";
      row.nextElementSibling?.classList.contains("client-detail") && row.nextElementSibling.remove();
      row.setAttribute("aria-expanded", String(!open));
      if (!open) row.insertAdjacentHTML("afterend", clientDetail(state.analysis.compat.clients.find((c) => c.id === row.dataset.client)));
    });
  }
}

function renderClients() {
  const all = $("#clients-all").checked;
  const families = new Map();
  for (const c of state.analysis.compat.clients) {
    if (!all && !KEY_FAMILIES.includes(c.family)) continue;
    if (!families.has(c.family)) families.set(c.family, { name: c.familyName, clients: [] });
    families.get(c.family).clients.push(c);
  }
  const rank = (f) => (KEY_FAMILIES.includes(f) ? KEY_FAMILIES.indexOf(f) : 99);
  $("#clients").innerHTML = [...families.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([, fam]) => `<p class="family-name">${esc(fam.name)}</p>${fam.clients.sort((a, b) => (a.score ?? 101) - (b.score ?? 101)).map((c) => clientRow({ ...c, name: c.platformName })).join("")}`)
    .join("");
  bindClientRows($("#clients"));
}

function renderFeatures() {
  const { compat } = state.analysis;
  const all = $("#features-all").checked;
  const q = $("#features-filter").value.trim().toLowerCase();
  const list = compat.features.filter((f) => (all || f.noCount || f.partialCount) && (!q || `${f.title} ${f.slug}`.toLowerCase().includes(q)));
  const clientsById = new Map(compat.clients.map((c) => [c.id, c]));
  if (!list.length) {
    $("#features").innerHTML = `<p class="empty-line">${compat.features.length ? "No features match." : "No HTML or CSS features detected."}</p>`;
    return;
  }
  $("#features").innerHTML = list
    .map((f) => {
      const fams = new Map();
      for (const c of compat.clients) {
        if (!KEY_FAMILIES.includes(c.family)) continue;
        const s = f.support[c.id].support;
        const prev = fams.get(c.family);
        const order = { n: 3, a: 2, y: 1, u: 0 };
        if (!prev || order[s] > order[prev.s]) fams.set(c.family, { name: c.familyName, s });
      }
      const chips = [...fams.values()].filter((x) => x.s === "n" || x.s === "a").sort((a) => (a.s === "n" ? -1 : 1)).map((x) => `<span class="chip ${x.s}">${esc(x.name)}</span>`).join("");
      // One line per client family: which of its apps fall short, with caniemail's notes once each.
      const byFamily = new Map();
      for (const [id, sup] of Object.entries(f.support)) {
        if (sup.support !== "n" && sup.support !== "a") continue;
        const c = clientsById.get(id);
        const fam = byFamily.get(c.family) ?? { name: c.familyName, worst: "a", apps: [], notes: new Set() };
        if (sup.support === "n") fam.worst = "n";
        fam.apps.push(c.platformName);
        for (const n of sup.notes) fam.notes.add(noteText(n));
        byFamily.set(c.family, fam);
      }
      const rank = (k) => (KEY_FAMILIES.includes(k) ? KEY_FAMILIES.indexOf(k) : 99);
      const rows = [...byFamily.entries()]
        .sort(([a, x], [b, y]) => (x.worst === y.worst ? rank(a) - rank(b) : x.worst === "n" ? -1 : 1))
        .map(([, fam]) => `<div><span class="sdot ${fam.worst}"></span><strong>${esc(fam.name)}</strong> <span class="faint">${esc(fam.apps.join(", "))}</span>${fam.notes.size ? `<br><span class="faint">${esc([...fam.notes].join(" "))}</span>` : ""}</div>`)
        .join("");
      return `<details class="feature">
        <summary>
          <span class="feature-head"><span class="feature-title">${esc(f.title)}</span><span class="feature-meta">${esc(f.category)} · ${f.count}×</span></span>
          <span class="chips">${chips || `<span class="chip y">Supported by major clients</span>`}</span>
        </summary>
        <div class="feature-body">
          <p>${esc(noteText(f.description))} <a href="${esc(f.url)}" target="_blank" rel="noopener">caniemail</a></p>
          ${f.samples.map((s) => `<code>${esc(s)}</code>`).join("")}
          ${rows ? `<div class="support-list">${rows}</div>` : ""}
        </div>
      </details>`;
    })
    .join("");
}

function findingHtml(f) {
  const where = Array.isArray(f.where) ? f.where : f.where ? [f.where] : [];
  return `<div class="finding ${f.level}"><span class="lvl"></span><div class="f-body"><span class="f-check">${esc(f.check)}</span>${esc(f.message)}
    ${f.help ? `<span class="f-sub">${esc(f.help)}</span>` : ""}
    ${where.length ? `<span class="f-sub">On ${esc(where.join(" · "))}</span>` : ""}</div></div>`;
}

function renderIssues() {
  if (!state.analysis) return;
  const findings = allFindings();
  const live = state.renderer === "live" ? "" : " Switch to Real engines to check WebKit, Chromium and Firefox too.";
  $("#issues").innerHTML = findings.length
    ? findings.map(findingHtml).join("") + `<p class="empty-line">Layout checks run on each screen and mode you open.${live}</p>`
    : `<p class="empty-line ok-line">No issues on the screens and modes checked.</p><p class="empty-line">Layout checks run on each screen and mode you open.${live}</p>`;
}

// ---------------------------------------------------------------------------------------
// Open sheet

function openSheet(tab = "paste") {
  const sheet = $("#sheet");
  selectSource(tab);
  if (!sheet.open) sheet.showModal();
  if (tab === "paste") $("#paste-input").focus();
}

function selectSource(key) {
  $$("[data-src]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.src === key)));
  $$("[data-src-panel]").forEach((p) => (p.hidden = p.dataset.srcPanel !== key));
}

function setupSheet() {
  const sheet = $("#sheet");
  for (const b of $$("[data-src]")) b.addEventListener("click", () => selectSource(b.dataset.src));
  for (const b of $$("[data-close-sheet]")) b.addEventListener("click", () => sheet.close());
  sheet.addEventListener("click", (e) => e.target === sheet && sheet.close());
  const run = () => {
    const text = $("#paste-input").value;
    if (!text.trim()) return toast("Paste some HTML or an .eml first", true);
    loadText(text, "Pasted email").catch((e) => toast(e.message, true));
  };
  $("#paste-check").addEventListener("click", run);
  $("#paste-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
  });
  $("#file-input").addEventListener("change", (e) => loadFile(e.target.files[0]));
}

function setupDragDrop() {
  const overlay = $("#drop-overlay");
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    loadFile(e.dataTransfer.files[0]);
  });
}

// --- Inbox connections -----------------------------------------------------------------

const CONN_FIELDS = {
  mailpit: [["name", "Name", "text", "Local Mailpit"], ["url", "Mailpit URL", "url", "http://localhost:8025"], ["username", "Username (basic auth)", "text", ""], ["password", "Password", "password", ""]],
  mailhog: [["name", "Name", "text", "Local MailHog"], ["url", "MailHog URL", "url", "http://localhost:8025"], ["username", "Username (basic auth)", "text", ""], ["password", "Password", "password", ""]],
  mailtrap: [["name", "Name", "text", "Mailtrap sandbox"], ["token", "API token", "password", ""], ["accountId", "Account ID", "text", ""], ["inboxId", "Inbox ID", "text", ""]],
};
const TYPE_NAMES = { mailpit: "Mailpit", mailhog: "MailHog", mailtrap: "Mailtrap" };

function setupInbox() {
  const select = $("#conn-select");
  const fill = (selected) => {
    const saved = state.info.sources.map((s) => `<option value="saved:${s.savedIndex}">${esc(s.name ?? s.url ?? s.type)} (config file)</option>`);
    const local = load(STORE.connections, []).map((c, i) => `<option value="local:${i}">${esc(c.name || c.url || c.type)} · ${TYPE_NAMES[c.type]}</option>`);
    const fresh = state.info.sourceTypes.map((t) => `<option value="new:${t}">New ${TYPE_NAMES[t]} connection</option>`);
    select.innerHTML = [...saved, ...local, ...fresh].join("");
    if (selected) select.value = selected;
    renderConnForm();
  };
  select.addEventListener("change", renderConnForm);
  $("#conn-connect").addEventListener("click", () => connect(fill).catch((e) => setInboxStatus(e.message, true)));
  $("#inbox-search").addEventListener("input", debounce(() => refreshInbox().catch((e) => setInboxStatus(e.message, true)), 350));
  fill();
}

function renderConnForm() {
  const [kind, ref] = $("#conn-select").value.split(":");
  const form = $("#conn-form");
  $("#conn-remember-wrap").hidden = kind === "saved";
  if (kind === "saved") {
    const s = state.info.sources.find((x) => String(x.savedIndex) === ref);
    form.innerHTML = `<p class="faint">${esc(TYPE_NAMES[s.type])} · ${esc(s.url ?? `account ${s.accountId}`)}${s.hasSecret ? " · credentials in the config file" : ""}</p>`;
    return;
  }
  const values = kind === "local" ? load(STORE.connections, [])[Number(ref)] : { type: ref };
  form.innerHTML = CONN_FIELDS[values.type].map(([key, label, type, ph]) => `<label>${esc(label)}<input name="${key}" type="${type}" placeholder="${esc(ph)}" value="${esc(values[key] ?? "")}"></label>`).join("");
  $("#conn-remember").checked = kind === "local";
}

async function connect(fill) {
  const [kind, ref] = $("#conn-select").value.split(":");
  let source;
  if (kind === "saved") source = { savedIndex: Number(ref) };
  else {
    source = { type: kind === "local" ? load(STORE.connections, [])[Number(ref)].type : ref };
    for (const input of $$("#conn-form input")) if (input.value.trim()) source[input.name] = input.value.trim();
    const required = source.type === "mailtrap" ? ["token", "accountId", "inboxId"] : ["url"];
    const missing = required.filter((k) => !source[k]);
    if (missing.length) return setInboxStatus(`Fill in ${missing.join(", ")}`, true);
  }
  state.connection = source;
  await refreshInbox();
  if (kind === "saved") return;
  const list = load(STORE.connections, []);
  if ($("#conn-remember").checked) {
    if (kind === "local") list[Number(ref)] = source;
    else list.push(source);
    save(STORE.connections, list);
    fill(`local:${kind === "local" ? ref : list.length - 1}`);
  } else if (kind === "local") {
    list.splice(Number(ref), 1);
    save(STORE.connections, list);
    fill();
  }
}

function setInboxStatus(text, isError = false) {
  const el = $("#inbox-status");
  el.textContent = text;
  el.style.color = isError ? "var(--bad)" : "";
}

async function refreshInbox() {
  if (!state.connection) return;
  setInboxStatus("Loading…");
  const { messages } = await api("/api/sources/list", { source: state.connection, search: $("#inbox-search").value.trim(), limit: 100 });
  $("#inbox-search").disabled = false;
  const list = $("#inbox-list");
  list.innerHTML = messages.length
    ? messages
        .map(
          (m) => `<li><button type="button" data-id="${esc(m.id)}"><span class="subj">${esc(m.subject || "(no subject)")}</span>
            <span class="from">${esc(m.to ? `to ${m.to}` : m.from)} · ${esc(String(m.date ?? "").slice(0, 16).replace("T", " "))}</span></button></li>`,
        )
        .join("")
    : `<li class="inbox-empty">No messages.</li>`;
  for (const b of $$("button", list)) {
    b.addEventListener("click", async () => {
      try {
        setInboxStatus("Opening…");
        await loadEmail(await api("/api/sources/get", { source: state.connection, id: b.dataset.id }));
        setInboxStatus("");
      } catch (e) {
        setInboxStatus(e.message, true);
      }
    });
  }
  setInboxStatus(`${messages.length} message${messages.length === 1 ? "" : "s"}`);
}

init();
