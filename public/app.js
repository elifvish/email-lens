import { layoutProbe } from "./probe.js";
import { applyMode, DEVICES, MODES } from "./variants.js";

const KEY_FAMILIES = ["gmail", "outlook", "apple-mail", "yahoo", "samsung-email", "thunderbird", "aol", "protonmail"];
const MODE_NOTES = {
  light: "As sent, with dark-mode media queries off.",
  dark: "Dark-mode media queries on, as Apple Mail and iOS Mail apply them. If nothing changes, the email has no dark-mode styles.",
  "forced-dark": "Simulates the Gmail and Outlook apps, which invert the colours of emails that don't handle dark mode themselves. Look for logos and text that disappear.",
  "no-style": "<style> blocks removed, as in Gmail with non-Google accounts (IMAP/POP) and some webmail. Only inline styles survive.",
  "no-images": "Images blocked, the default in Outlook and many corporate clients. Alt text and background colours have to carry the message.",
};
const STORAGE_KEY = "email-lens.connections";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const stripTags = (s) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const state = {
  info: null,
  email: null,
  analysis: null,
  devices: new Set(["iphone-se", "android", "desktop"]),
  mode: "light",
  previewFindings: new Map(),
  renderFindings: [],
  connection: null,
  live: { devices: new Set(["iphone-se", "android", "thunderbird"]), mode: "light", tiles: new Map(), running: false },
};

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
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2500);
}

function selectTab(group, key) {
  for (const b of $$(`[data-${group}]`)) b.setAttribute("aria-selected", String(b.dataset[group] === key));
  for (const p of $$(`[data-${group}-panel]`)) p.hidden = p.dataset[`${group}Panel`] !== key;
}

function scoreClass(score) {
  return score == null ? "" : score >= 90 ? "good" : score >= 75 ? "mid" : "bad";
}
function scoreColor(score) {
  return score >= 90 ? "var(--y)" : score >= 75 ? "var(--a)" : "var(--n)";
}

// ---------------------------------------------------------------------------------------
// Startup

async function init() {
  for (const b of $$("[data-src]")) b.addEventListener("click", () => selectTab("src", b.dataset.src));
  for (const b of $$("[data-tab]")) b.addEventListener("click", () => selectTab("tab", b.dataset.tab));

  try {
    state.info = await api("/api/info");
  } catch (e) {
    toast(`Can't reach the email-lens server: ${e.message}`, true);
    return;
  }
  showDataInfo(state.info.data);
  const r = state.info.render;
  const pill = $("#engine-info");
  pill.textContent = r.available ? `Engines: ${r.engines.join(", ")}` : "Live engines off";
  pill.className = `pill${r.available ? " ok" : ""}`;
  pill.title = r.available ? "Playwright browsers found" : "Install Playwright browsers with `npm run browsers` to enable engine renders";

  setupPaste();
  setupUpload();
  setupInbox();
  setupPreviewControls();
  setupReportControls();
}

function showDataInfo(d) {
  $("#data-info").textContent = `caniemail data ${d.updated.slice(0, 10)} · ${d.features} features · ${d.clients} clients`;
}

// ---------------------------------------------------------------------------------------
// Sources

function looksLikeEml(text) {
  const head = text.slice(0, 4000);
  return /^[A-Za-z-]+:\s.*$/m.test(head.split(/\r?\n\r?\n/)[0]) && /^(mime-version|content-type|received|from|subject):/im.test(head) && !/^\s*</.test(text);
}

async function loadRaw(text, name = "Pasted email") {
  if (looksLikeEml(text)) {
    const msg = await api("/api/parse", { raw: text });
    return loadEmail({ ...msg, origin: "eml" });
  }
  return loadEmail({ subject: name, html: text, text: null, origin: "paste" });
}

function setupPaste() {
  const run = (name) => {
    const text = $("#paste-input").value;
    if (!text.trim()) return toast("Paste some HTML or an .eml first", true);
    loadRaw(text, name).catch((e) => toast(e.message, true));
  };
  $("#paste-check").addEventListener("click", () => run());
  $("#paste-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
  });
  for (const b of $$("[data-sample]")) {
    b.addEventListener("click", async () => {
      $("#paste-input").value = await fetch(`samples/${b.dataset.sample}.html`).then((r) => r.text());
      run(`Sample: ${b.textContent}`);
    });
  }
}

function setupUpload() {
  const zone = $("#dropzone");
  const handle = async (file) => {
    if (!file) return;
    const text = await file.text();
    try {
      if (/\.eml$/i.test(file.name) || looksLikeEml(text)) await loadEmail({ ...(await api("/api/parse", { raw: text })), origin: file.name });
      else await loadEmail({ subject: file.name, html: text, text: null, origin: file.name });
    } catch (e) {
      toast(e.message, true);
    }
  };
  $("#file-input").addEventListener("change", (e) => handle(e.target.files[0]));
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    handle(e.dataTransfer.files[0]);
  });
}

// --- Inbox connections -----------------------------------------------------------------

const CONN_FIELDS = {
  mailpit: [
    ["name", "Name", "text", "Local Mailpit"],
    ["url", "Mailpit URL", "url", "http://localhost:8025"],
    ["username", "Username (if basic auth)", "text", ""],
    ["password", "Password", "password", ""],
  ],
  mailhog: [
    ["name", "Name", "text", "Local MailHog"],
    ["url", "MailHog URL", "url", "http://localhost:8025"],
    ["username", "Username (if basic auth)", "text", ""],
    ["password", "Password", "password", ""],
  ],
  mailtrap: [
    ["name", "Name", "text", "Mailtrap sandbox"],
    ["token", "API token", "password", ""],
    ["accountId", "Account ID", "text", ""],
    ["inboxId", "Inbox ID", "text", ""],
  ],
};

function storedConnections() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function saveConnections(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: connection still works for this session */
  }
}

function setupInbox() {
  const select = $("#conn-select");
  const fillSelect = (selected) => {
    const saved = state.info.sources.map((s) => `<option value="saved:${s.savedIndex}">${esc(s.name ?? s.url ?? s.type)} · ${esc(s.type)} (config file)</option>`);
    const local = storedConnections().map((c, i) => `<option value="local:${i}">${esc(c.name || c.url || c.type)} · ${esc(c.type)}</option>`);
    const fresh = state.info.sourceTypes.map((t) => `<option value="new:${t}">New ${t === "mailpit" ? "Mailpit" : t === "mailhog" ? "MailHog" : "Mailtrap"} connection…</option>`);
    select.innerHTML = [...saved, ...local, ...fresh].join("");
    if (selected) select.value = selected;
    renderConnForm();
  };
  select.addEventListener("change", renderConnForm);
  $("#conn-connect").addEventListener("click", () => connect().catch((e) => setInboxStatus(e.message, true)));
  let searchTimer;
  $("#inbox-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshInbox().catch((e) => setInboxStatus(e.message, true)), 350);
  });
  fillSelect();
  state.fillConnSelect = fillSelect;
}

function renderConnForm() {
  const [kind, ref] = $("#conn-select").value.split(":");
  const form = $("#conn-form");
  $("#conn-remember").parentElement.hidden = kind !== "new" && kind !== "local";
  if (kind === "saved") {
    const s = state.info.sources.find((x) => String(x.savedIndex) === ref);
    form.innerHTML = `<p class="hint">${esc(s.type)} · ${esc(s.url ?? `account ${s.accountId}`)}${s.hasSecret ? " · credentials stored in the config file" : ""}</p>`;
    return;
  }
  const values = kind === "local" ? storedConnections()[Number(ref)] : { type: ref };
  form.innerHTML = CONN_FIELDS[values.type]
    .map(([key, label, type, placeholder]) => `<label>${esc(label)}<input name="${key}" type="${type}" placeholder="${esc(placeholder)}" value="${esc(values[key] ?? "")}"></label>`)
    .join("");
  $("#conn-remember").checked = kind === "local";
}

function currentConnection() {
  const [kind, ref] = $("#conn-select").value.split(":");
  if (kind === "saved") return { source: { savedIndex: Number(ref) }, kind };
  const type = kind === "local" ? storedConnections()[Number(ref)].type : ref;
  const cfg = { type };
  for (const input of $$("#conn-form input")) if (input.value.trim()) cfg[input.name] = input.value.trim();
  return { source: cfg, kind, ref };
}

async function connect() {
  const conn = currentConnection();
  const required = conn.source.type === "mailtrap" ? ["token", "accountId", "inboxId"] : conn.kind === "saved" ? [] : ["url"];
  const missing = required.filter((k) => !conn.source[k]);
  if (missing.length) return setInboxStatus(`Fill in: ${missing.join(", ")}`, true);
  state.connection = conn.source;
  await refreshInbox();
  if (conn.kind !== "saved") {
    const list = storedConnections();
    if ($("#conn-remember").checked) {
      if (conn.kind === "local") list[Number(conn.ref)] = conn.source;
      else list.push(conn.source);
      saveConnections(list);
      state.fillConnSelect(`local:${conn.kind === "local" ? conn.ref : list.length - 1}`);
    } else if (conn.kind === "local") {
      list.splice(Number(conn.ref), 1);
      saveConnections(list);
      state.fillConnSelect();
    }
  }
}

function setInboxStatus(text, isError = false) {
  const el = $("#inbox-status");
  el.textContent = text;
  el.style.color = isError ? "var(--n)" : "";
}

async function refreshInbox() {
  if (!state.connection) return;
  setInboxStatus("Loading…");
  const { messages } = await api("/api/sources/list", { source: state.connection, search: $("#inbox-search").value.trim(), limit: 100 });
  $("#inbox-browser").hidden = false;
  const list = $("#inbox-list");
  list.innerHTML = messages
    .map(
      (m) => `<li><button type="button" data-id="${esc(m.id)}">
        <span class="subj">${esc(m.subject || "(no subject)")}</span>
        <span class="from">${esc(m.to ? `to ${m.to}` : m.from)} · ${esc(String(m.date ?? "").slice(0, 16).replace("T", " "))}</span>
      </button></li>`,
    )
    .join("");
  for (const b of $$("button", list)) {
    b.addEventListener("click", async () => {
      $$("button", list).forEach((x) => x.classList.toggle("active", x === b));
      try {
        setInboxStatus("Opening…");
        const msg = await api("/api/sources/get", { source: state.connection, id: b.dataset.id });
        await loadEmail({ ...msg, origin: state.connection.type });
        setInboxStatus("");
      } catch (e) {
        setInboxStatus(e.message, true);
      }
    });
  }
  setInboxStatus(messages.length ? `${messages.length} message(s)` : "No messages");
}

// ---------------------------------------------------------------------------------------
// Report

async function loadEmail(email) {
  if (!email.html?.trim()) throw new Error("This message has no HTML part");
  state.email = email;
  state.previewFindings = new Map();
  state.renderFindings = [];
  await stopLive();
  state.analysis = await api("/api/analyze", { html: email.html, text: email.text ?? null });
  $("#empty").hidden = true;
  $("#result").hidden = false;
  renderSummary();
  renderPreview();
  renderClients();
  renderFeatures();
  renderChecks();
  renderSource();
  $("#live-status").textContent = "";
  if (isTabOpen("live")) startLive();
}

function renderSummary() {
  const { email, analysis } = state;
  $("#r-subject").textContent = email.subject || "(no subject)";
  const parts = [];
  if (email.from) parts.push(`${email.from}${email.to ? ` → ${email.to}` : ""}`);
  if (email.date) parts.push(String(email.date).slice(0, 16).replace("T", " "));
  parts.push(`${(analysis.bytes / 1024).toFixed(1)} KB HTML`);
  parts.push(`${analysis.compat.features.length} HTML/CSS features detected`);
  $("#r-meta").textContent = parts.join(" · ");

  const overall = analysis.compat.overall;
  $("#r-score").textContent = overall == null ? "–" : `${Math.round(overall)}%`;
  $("#r-score").className = `stat-value ${scoreClass(overall)}`;
  const keyClients = analysis.compat.clients.filter((c) => KEY_FAMILIES.includes(c.family) && c.score != null);
  const worst = keyClients.sort((a, b) => a.score - b.score)[0];
  $("#r-worst").textContent = worst ? `${Math.round(worst.score)}%` : "–";
  $("#r-worst").className = `stat-value ${scoreClass(worst?.score)}`;
  $("#r-worst-label").textContent = worst ? `lowest: ${worst.name}` : "lowest";
  updateCounts();
}

function allFindings() {
  return [...state.analysis.lint, ...mergedPreviewFindings(), ...state.renderFindings];
}

function updateCounts() {
  const all = allFindings();
  const errors = all.filter((f) => f.level === "error").length;
  const warns = all.filter((f) => f.level === "warn").length;
  $("#r-errors").textContent = errors;
  $("#r-errors").className = `stat-value ${errors ? "bad" : "good"}`;
  $("#r-warns").textContent = warns;
  $("#r-warns").className = `stat-value ${warns ? "mid" : "good"}`;
  const c = $("#checks-count");
  c.textContent = errors + warns || "";
  c.className = `count${errors ? " bad" : ""}`;
}

// --- Preview ---------------------------------------------------------------------------

function setupPreviewControls() {
  $("#device-chips").innerHTML = DEVICES.map(
    (d) => `<button type="button" class="chip" data-device="${d.key}" aria-pressed="${state.devices.has(d.key)}">${esc(d.label)} <span class="muted">${d.width}</span></button>`,
  ).join("");
  for (const b of $$("[data-device]")) {
    b.addEventListener("click", () => {
      const k = b.dataset.device;
      if (state.devices.has(k) && state.devices.size > 1) state.devices.delete(k);
      else state.devices.add(k);
      b.setAttribute("aria-pressed", String(state.devices.has(k)));
      if (state.email) renderPreview();
    });
  }
  $("#mode-seg").innerHTML = MODES.map((m) => `<button type="button" role="radio" data-mode="${m.key}" aria-checked="${m.key === state.mode}">${esc(m.label)}</button>`).join("");
  for (const b of $$("[data-mode]")) {
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      $$("[data-mode]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      if (state.email) renderPreview();
    });
  }
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.email && rescaleFrames(), 150);
  });
}

function renderPreview() {
  $("#mode-note").textContent = MODE_NOTES[state.mode];
  const container = $("#frames");
  container.innerHTML = "";
  const html = withBaseTarget(applyMode(state.email.html, state.mode));
  for (const device of DEVICES.filter((d) => state.devices.has(d.key))) {
    const frame = document.createElement("div");
    frame.className = "frame";
    frame.dataset.width = device.width;
    frame.innerHTML = `<div class="frame-head"><strong>${esc(device.label)}</strong><span class="muted">${device.width}px</span><span class="frame-badges"></span></div><div class="frame-viewport"></div>`;
    const viewport = $(".frame-viewport", frame);
    if (state.mode === "dark") viewport.classList.add("dark-canvas");
    const iframe = document.createElement("iframe");
    iframe.title = `${device.label} preview`;
    // No allow-scripts: like every email client, the email's own scripts never run.
    iframe.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    iframe.style.width = `${device.width}px`;
    iframe.style.height = `${device.height}px`;
    iframe.srcdoc = html;
    iframe.addEventListener("load", () => onFrameLoad(iframe, frame, device));
    viewport.append(iframe);
    container.append(frame);
  }
  rescaleFrames();
}

function withBaseTarget(html) {
  const tag = '<base target="_blank">';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
}

function frameScale(width) {
  const available = $("#frames").clientWidth - 24;
  return Math.min(1, available / width);
}

function rescaleFrames() {
  for (const frame of $$("#frames .frame")) {
    const iframe = $("iframe", frame);
    const width = Number(frame.dataset.width);
    const height = parseFloat(iframe.style.height);
    const scale = frameScale(width);
    iframe.style.transform = scale < 1 ? `scale(${scale})` : "";
    const viewport = $(".frame-viewport", frame);
    viewport.style.width = `${Math.round(width * scale)}px`;
    viewport.style.height = `${Math.round(height * scale)}px`;
  }
}

function onFrameLoad(iframe, frame, device) {
  const doc = iframe.contentDocument;
  if (!doc) return;
  const fit = () => {
    iframe.style.height = `${Math.max(device.height * 0.6, doc.documentElement.scrollHeight)}px`;
    rescaleFrames();
  };
  fit();
  for (const img of doc.images) if (!img.complete) img.addEventListener("load", fit, { once: true });

  let issues = [];
  if (["light", "dark", "no-style"].includes(state.mode)) {
    try {
      issues = layoutProbe(iframe.contentWindow, { mobile: device.mobile, mode: state.mode, screenWidth: device.width });
    } catch (e) {
      console.warn("probe failed", e);
    }
    const label = `${device.label} ${device.width}px, ${MODES.find((m) => m.key === state.mode).label}`;
    state.previewFindings.set(`${device.key}|${state.mode}`, issues.map((i) => ({ ...i, where: label })));
  }
  const errors = issues.filter((i) => i.level === "error").length;
  const warns = issues.filter((i) => i.level === "warn").length;
  const badges = $(".frame-badges", frame);
  if (!["light", "dark", "no-style"].includes(state.mode)) badges.innerHTML = "";
  else if (!errors && !warns) badges.innerHTML = `<span class="badge ok">OK</span>`;
  else {
    badges.innerHTML = `${errors ? `<span class="badge error">${errors} error${errors > 1 ? "s" : ""}</span>` : ""}${warns ? `<span class="badge warn">${warns} warning${warns > 1 ? "s" : ""}</span>` : ""}`;
    badges.title = issues.map((i) => `${i.check}: ${i.message}`).join("\n");
  }
  renderChecks();
  updateCounts();
}

function mergedPreviewFindings() {
  return mergeFindings([...state.previewFindings.values()].flat());
}

function mergeFindings(list) {
  const map = new Map();
  for (const f of list) {
    const key = `${f.level}|${f.check}|${f.message}`;
    const hit = map.get(key) ?? { ...f, where: [] };
    const where = Array.isArray(f.where) ? f.where : f.where ? [f.where] : [];
    for (const w of where) if (!hit.where.includes(w)) hit.where.push(w);
    map.set(key, hit);
  }
  const order = { error: 0, warn: 1, info: 2 };
  return [...map.values()].sort((a, b) => order[a.level] - order[b.level]);
}

// --- Clients ---------------------------------------------------------------------------

function setupReportControls() {
  $("#clients-key").addEventListener("change", renderClients);
  $("#features-problems").addEventListener("change", renderFeatures);
  $("#features-filter").addEventListener("input", renderFeatures);
  setupLiveControls();
  $("#copy-source").addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.email.html);
    toast("HTML copied");
  });
  $("#update-data").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const { data } = await api("/api/update-data", {});
      showDataInfo(data);
      toast("caniemail data updated");
      if (state.email) await loadEmail(state.email);
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });
  if (!state.info.render.available) {
    $("#live-start").disabled = true;
    $("#live-status").textContent = "Playwright browsers not found. Run `npm run browsers`, then restart.";
  }
}

function renderClients() {
  const { compat } = state.analysis;
  const onlyKey = $("#clients-key").checked;
  const byFeature = new Map(compat.features.map((f) => [f.slug, f]));
  const families = new Map();
  for (const c of compat.clients) {
    if (onlyKey && !KEY_FAMILIES.includes(c.family)) continue;
    if (!families.has(c.family)) families.set(c.family, { name: c.familyName, clients: [] });
    families.get(c.family).clients.push(c);
  }
  const ordered = [...families.entries()].sort(([a], [b]) => {
    const ia = KEY_FAMILIES.indexOf(a);
    const ib = KEY_FAMILIES.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  $("#clients").innerHTML = ordered
    .map(
      ([, fam]) => `<div class="family"><h3>${esc(fam.name)}</h3>${fam.clients
        .sort((a, b) => (a.score ?? 101) - (b.score ?? 101))
        .map((c) => {
          const issues = [...c.no.map((s) => ["n", s]), ...c.partial.map((s) => ["a", s])];
          const detail = issues.length
            ? `<ul>${issues
                .map(([lvl, slug]) => {
                  const f = byFeature.get(slug);
                  const notes = f.support[c.id].notes.map((n) => `<span class="note">${esc(stripTags(n))}</span>`).join("");
                  return `<li><i class="dot ${lvl}"></i><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.title)}</a> <span class="muted">×${f.count}</span>${notes}</li>`;
                })
                .join("")}</ul>`
            : `<span class="ok-line">Everything this email uses is supported.</span>`;
          return `<button type="button" class="platform" aria-expanded="false">
              <span>${esc(c.platformName)}</span>
              <span class="bar"><span style="width:${c.score ?? 0}%;background:${scoreColor(c.score ?? 0)}"></span></span>
              <span class="score">${c.score == null ? "–" : Math.round(c.score) + "%"}</span>
            </button><div class="platform-detail" hidden>${detail}</div>`;
        })
        .join("")}</div>`,
    )
    .join("");
  for (const b of $$("#clients .platform")) {
    b.addEventListener("click", () => {
      const open = b.getAttribute("aria-expanded") === "true";
      b.setAttribute("aria-expanded", String(!open));
      b.nextElementSibling.hidden = open;
    });
  }
}

// --- Features --------------------------------------------------------------------------

function familyStatus(feature, clients) {
  const out = new Map();
  for (const c of clients) {
    if (!KEY_FAMILIES.includes(c.family)) continue;
    const s = feature.support[c.id].support;
    const prev = out.get(c.family) ?? { name: c.familyName, status: null };
    const rank = { n: 3, a: 2, y: 1, u: 0 };
    if (prev.status == null || rank[s] > rank[prev.status]) prev.status = s;
    out.set(c.family, prev);
  }
  return [...out.values()];
}

function renderFeatures() {
  const { compat } = state.analysis;
  const onlyProblems = $("#features-problems").checked;
  const q = $("#features-filter").value.trim().toLowerCase();
  const list = compat.features.filter((f) => (!onlyProblems || f.noCount || f.partialCount) && (!q || `${f.title} ${f.slug}`.toLowerCase().includes(q)));
  if (!list.length) {
    $("#features").innerHTML = `<p class="muted">${compat.features.length ? "No features match." : "No HTML/CSS features detected."}</p>`;
    return;
  }
  const clientsById = new Map(compat.clients.map((c) => [c.id, c]));
  $("#features").innerHTML = list
    .map((f) => {
      const fams = familyStatus(f, compat.clients)
        .filter((x) => x.status === "n" || x.status === "a")
        .sort((a, b) => (a.status === "n" ? -1 : 1) - (b.status === "n" ? -1 : 1))
        .map((x) => `<span class="fam ${x.status}">${esc(x.name)}</span>`)
        .join("");
      const rows = Object.entries(f.support)
        .filter(([, s]) => s.support === "n" || s.support === "a")
        .sort(([, a], [, b]) => (a.support === "n" ? -1 : 1) - (b.support === "n" ? -1 : 1))
        .map(([id, s]) => `<tr><td><i class="dot ${s.support}"></i>${esc(clientsById.get(id).name)}</td><td>${s.notes.map((n) => esc(stripTags(n))).join("<br>") || (s.support === "n" ? "Not supported." : "Partial support.")}</td></tr>`)
        .join("");
      return `<details class="feature">
        <summary>
          <span class="feature-title">${esc(f.title)}<small>${esc(f.category)} · used ${f.count}×</small></span>
          <span class="feature-families">${fams || `<span class="fam y">supported by major clients</span>`}</span>
        </summary>
        <div class="feature-body">
          <p class="muted">${esc(stripTags(f.description))} <a href="${esc(f.url)}" target="_blank" rel="noopener">caniemail ↗</a></p>
          ${f.samples.map((s) => `<code>${esc(s)}</code>`).join("")}
          ${rows ? `<table class="support-table"><tbody>${rows}</tbody></table>` : ""}
          <p class="muted">${f.noCount} client(s) unsupported, ${f.partialCount} partial; all others supported or untested.</p>
        </div>
      </details>`;
    })
    .join("");
}

// --- Checks ----------------------------------------------------------------------------

function findingHtml(f) {
  const where = Array.isArray(f.where) ? f.where : f.where ? [f.where] : [];
  return `<div class="finding ${f.level}"><span class="lvl">${f.level}</span><span class="chk">${esc(f.check)}</span>${esc(f.message)}
    ${f.help ? `<span class="help">${esc(f.help)}</span>` : ""}
    ${where.length ? `<span class="where">Seen on: ${esc(where.join(" · "))}</span>` : ""}</div>`;
}

function renderChecks() {
  if (!state.analysis) return;
  const groups = [
    ["Email", state.analysis.lint, "No problems in the HTML itself."],
    ["Preview checks (this browser)", mergedPreviewFindings(), "Run on each preview you open. Switch devices and modes to check more combinations."],
    ["Live engines", state.renderFindings, "Open Live engines to check WebKit, Chromium and Gecko."],
  ];
  $("#checks").innerHTML = groups
    .map(([title, list, empty]) => `<h3 class="group-title">${esc(title)}</h3>${list.length ? list.map(findingHtml).join("") : `<p class="muted">${esc(empty)}</p>`}`)
    .join("");
}

// --- Live engines ----------------------------------------------------------------------
// Each tile is a real engine page on the server. Frames are long-polled as JPEGs held only
// in memory; wheel, hover, click and keys are forwarded. Nothing is stored anywhere.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTabOpen(key) {
  return $(`[data-tab="${key}"]`).getAttribute("aria-selected") === "true";
}

function setupLiveControls() {
  const live = state.live;
  $("#live-device-chips").innerHTML = DEVICES.map(
    (d) => `<button type="button" class="chip" data-live-device="${d.key}" aria-pressed="${live.devices.has(d.key)}">${esc(d.label)} <span class="muted">${d.engine}</span></button>`,
  ).join("");
  for (const b of $$("[data-live-device]")) {
    b.addEventListener("click", () => {
      const device = DEVICES.find((d) => d.key === b.dataset.liveDevice);
      if (live.devices.has(device.key) && live.devices.size > 1) {
        live.devices.delete(device.key);
        if (live.running) removeTile(device.key);
      } else if (!live.devices.has(device.key)) {
        live.devices.add(device.key);
        if (live.running) addTile(device);
      }
      b.setAttribute("aria-pressed", String(live.devices.has(device.key)));
    });
  }
  $("#live-mode-seg").innerHTML = MODES.map((m) => `<button type="button" role="radio" data-live-mode="${m.key}" aria-checked="${m.key === live.mode}">${esc(m.label)}</button>`).join("");
  for (const b of $$("[data-live-mode]")) {
    b.addEventListener("click", async () => {
      live.mode = b.dataset.liveMode;
      $$("[data-live-mode]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      if (live.running) {
        await stopLive();
        startLive();
      }
    });
  }
  $("#live-start").addEventListener("click", startLive);
  $("#live-stop").addEventListener("click", stopLive);
  $('[data-tab="live"]').addEventListener("click", () => {
    if (state.email && !live.running && state.info.render.available) startLive();
  });
  // Leaving the page ends every session right away instead of waiting for the idle timeout.
  window.addEventListener("pagehide", () => {
    const ids = [...live.tiles.values()].map((t) => t.id).filter(Boolean);
    if (ids.length) fetch("/api/live/close", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
  });
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => live.tiles.forEach(sizeTile), 150);
  });
}

async function startLive() {
  const live = state.live;
  if (!state.email || live.running || !state.info.render.available) return;
  live.running = true;
  state.renderFindings = [];
  $("#live-start").hidden = true;
  $("#live-stop").hidden = false;
  $("#live-status").textContent = "Starting engines…";
  await Promise.all(DEVICES.filter((d) => live.devices.has(d.key)).map(addTile));
  if (live.running) $("#live-status").textContent = `Live in ${new Set([...live.tiles.values()].map((t) => t.device.engine)).size} engine(s). Scroll, hover and click inside a tile.`;
}

async function stopLive() {
  const live = state.live;
  const keys = [...live.tiles.keys()];
  live.running = false;
  $("#live-start").hidden = false;
  $("#live-stop").hidden = true;
  $("#live-status").textContent = keys.length ? "Stopped. Engine pages closed." : "";
  await Promise.all(keys.map(removeTile));
}

async function addTile(device) {
  const live = state.live;
  if (live.tiles.has(device.key)) return;
  const tile = { device, id: null, version: -1, abort: new AbortController(), closed: false, queue: Promise.resolve(), url: null };
  live.tiles.set(device.key, tile);
  const el = document.createElement("div");
  el.className = "frame live-tile";
  el.innerHTML = `<div class="frame-head">
      <span class="live-dot" title="Live"></span><strong>${esc(device.label)}</strong><span class="muted">${device.width}px · ${device.engine}</span>
      <span class="frame-badges"></span>
      <span class="tools">
        <button type="button" class="icon-btn" data-act="top" title="Scroll to top">Top</button>
        <button type="button" class="icon-btn" data-act="snap" title="Open a full-length image in a new tab (not saved)">Snapshot</button>
        <button type="button" class="icon-btn" data-act="close" aria-label="Close ${esc(device.label)}">✕</button>
      </span>
    </div>
    <div class="live-screen" tabindex="0" role="img" aria-label="Live ${esc(device.label)} view in ${device.engine}. Use arrow keys, Page Up/Down, Home and End to scroll.">
      <img alt="" draggable="false">
      <div class="scrollbar"><span hidden></span></div>
      <div class="overlay"><span><span class="spinner"></span>Starting ${esc(device.engine)}…</span></div>
    </div>
    <div class="live-link" hidden></div>`;
  tile.el = el;
  const order = DEVICES.map((d) => d.key);
  const next = [...live.tiles.values()].filter((t) => t.el?.isConnected).find((t) => order.indexOf(t.device.key) > order.indexOf(device.key));
  $("#live-tiles").insertBefore(el, next?.el ?? null);
  sizeTile(tile);
  $('[data-act="close"]', el).addEventListener("click", () => {
    live.devices.delete(device.key);
    $(`[data-live-device="${device.key}"]`).setAttribute("aria-pressed", "false");
    removeTile(device.key);
  });

  try {
    const r = await api("/api/live", { html: state.email.html, device: device.key, mode: live.mode });
    tile.id = r.id;
    if (tile.closed) return closeOnServer([r.id]);
    showTileFindings(tile, r.findings);
    bindTileInput(tile);
    pollTile(tile);
  } catch (e) {
    $(".overlay", el).textContent = `Couldn't start ${device.engine}: ${e.message}`;
  }
}

async function removeTile(key) {
  const tile = state.live.tiles.get(key);
  if (!tile) return;
  state.live.tiles.delete(key);
  tile.closed = true;
  tile.abort.abort();
  tile.el.remove();
  if (tile.url) URL.revokeObjectURL(tile.url);
  if (tile.id) await closeOnServer([tile.id]);
}

function closeOnServer(ids) {
  return api("/api/live/close", { ids }).catch(() => {});
}

function sizeTile(tile) {
  const { device } = tile;
  const scale = Math.min(1, ($("#live-tiles").clientWidth - 24) / device.width);
  const screen = $(".live-screen", tile.el);
  screen.style.width = `${Math.round(device.width * scale)}px`;
  screen.style.height = `${Math.round(device.height * scale)}px`;
}

function showTileFindings(tile, findings) {
  state.renderFindings = mergeFindings([...state.renderFindings, ...findings]);
  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  const badges = $(".frame-badges", tile.el);
  if (["light", "dark", "no-style"].includes(state.live.mode)) {
    badges.innerHTML = errors || warns
      ? `${errors ? `<span class="badge error">${errors}</span>` : ""}${warns ? `<span class="badge warn">${warns}</span>` : ""}`
      : `<span class="badge ok">OK</span>`;
    badges.title = findings.map((f) => `${f.check}: ${f.message}`).join("\n") || "No layout problems";
  }
  renderChecks();
  updateCounts();
}

async function pollTile(tile) {
  const img = $("img", tile.el);
  const overlay = $(".overlay", tile.el);
  const thumb = $(".scrollbar span", tile.el);
  const dot = $(".live-dot", tile.el);
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
      dot.classList.remove("on");
      await sleep(1000);
      continue;
    }
    if (res.status === 204) continue;
    if (!res.ok) {
      dot.classList.remove("on");
      overlay.hidden = false;
      overlay.innerHTML = `<span>This live view has ended. <button type="button" class="icon-btn">Restart</button></span>`;
      $("button", overlay).addEventListener("click", async () => {
        await removeTile(tile.device.key);
        addTile(tile.device);
      });
      return;
    }
    const blob = await res.blob();
    tile.version = Number(res.headers.get("X-Frame-Version"));
    const [y, height, view] = (res.headers.get("X-Scroll") ?? "0,1,1").split(",").map(Number);
    thumb.hidden = height <= view + 1;
    thumb.style.top = `${(y / height) * 100}%`;
    thumb.style.height = `${Math.min(100, (view / height) * 100)}%`;
    const links = JSON.parse(decodeURIComponent(res.headers.get("X-Links") || "%5B%5D"));
    if (links.length) showLink(tile, links.at(-1));
    const error = decodeURIComponent(res.headers.get("X-Error") || "");
    if (blob.size) {
      tile.previousUrl = tile.url;
      tile.url = URL.createObjectURL(blob);
      img.src = tile.url;
      overlay.hidden = !error;
      dot.classList.add("on");
    }
    if (error) {
      overlay.hidden = false;
      overlay.textContent = error;
    }
  }
}

function showLink(tile, url) {
  const box = $(".live-link", tile.el);
  box.hidden = false;
  const safe = /^https?:\/\//i.test(url);
  box.innerHTML = `Link clicked: ${safe ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : esc(url)}`;
}

function bindTileInput(tile) {
  const { device } = tile;
  const screen = $(".live-screen", tile.el);
  const send = (body) => {
    tile.queue = tile.queue.then(() =>
      fetch(`/api/live/${tile.id}/input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {}),
    );
  };
  const ratio = () => device.width / screen.getBoundingClientRect().width;
  const point = (e) => {
    const r = screen.getBoundingClientRect();
    return { x: (e.clientX - r.left) * ratio(), y: (e.clientY - r.top) * ratio() };
  };

  let wheel = null;
  screen.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? device.height : 1;
      const p = point(e);
      if (!wheel) {
        wheel = { type: "wheel", dx: 0, dy: 0, ...p };
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
  screen.addEventListener("mousemove", (e) => {
    if (Date.now() - lastMove < 120) return;
    lastMove = Date.now();
    send({ type: "move", ...point(e) });
  });
  screen.addEventListener("click", (e) => {
    screen.focus({ preventScroll: true });
    send({ type: "click", ...point(e) });
  });
  screen.addEventListener("keydown", (e) => {
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

// --- Source ----------------------------------------------------------------------------

function renderSource() {
  $("#source").textContent = state.email.html;
  $("#source-size").textContent = `${(state.analysis.bytes / 1024).toFixed(1)} KB`;
  const hasText = state.email.text != null && state.email.text !== "";
  $("#text-part").hidden = !hasText;
  if (hasText) $("#source-text").textContent = state.email.text;
}

init();
