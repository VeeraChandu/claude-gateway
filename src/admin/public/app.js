// Gateway admin UI. Vanilla JS, no build step. All DOM is built with
// createElement + text nodes (via h()), never from HTML strings, so server data
// can't inject markup. The CSP forbids inline styles, so styling is classes only.

import { checkModelId, suggestModelId, vendorToken } from "/admin/model-names.js";

const app = document.getElementById("app");
const toasts = document.getElementById("toasts");

const TABS = [
  ["overview", "Overview"],
  ["connections", "Connections"],
  ["routing", "Routing"],
  ["keys", "Client keys"],
  ["settings", "Settings"]
];

/**
 * How the API key is sent. Most OpenAI-compatible providers want "bearer";
 * Azure OpenAI wants its own "api-key" header.
 */
const AUTH_SCHEMES = [
  { value: "bearer", label: "Authorization: Bearer (most providers)" },
  { value: "x-api-key", label: "x-api-key header" },
  { value: "header", label: "Custom header (Azure OpenAI)" },
  { value: "none", label: "No credential (local server)" }
];

const PRESETS = [
  { label: "OpenAI", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { label: "OpenRouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "DeepSeek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { label: "Groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { label: "Venice", name: "Venice", baseUrl: "https://api.venice.ai/api/v1" },
  { label: "Ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { label: "Azure OpenAI", name: "Azure OpenAI", baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT", authScheme: "header", authHeader: "api-key", queryParams: "api-version=2024-10-21" },
  { label: "Custom", name: "", baseUrl: "" }
];

const FAMILIES = [
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["fable", "Fable"]
];

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** UI state */
const S = {
  session: null, // { authenticated, setupRequired }
  data: null, // /state payload
  activity: [],
  models: new Map(), // providerId → Promise<{ ok, models, error }>
  tests: new Map(), // providerId → last test result, kept across redraws
  openRow: null, // activity id expanded on Overview
  filter: "all", // Overview filter: "all" | "errors" | key name
  dirty: false, // unsaved Routing edits
  tab: null, // tab currently rendered
  pollTimer: null
};

// ── Helpers ────────────────────────────────────────────────────────────────

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "value") value = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "disabled" || k === "checked" || k === "open" || k === "required") el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** A small stroke icon. `d` is one or more path strings. */
function icon(...paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "icon" })) svg.setAttribute(k, v);
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
const chevron = () => icon("m6 9 6 6 6-6");
const searchIcon = () => icon("M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "m20 20-3.5-3.5");
const checkIcon = () => icon("m5 12 5 5 9-10");

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const res = await fetch(`/admin/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-cgw-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !["/login", "/setup"].includes(path)) {
    // Session expired (e.g. gateway restarted): drop any open dialog and show sign-in.
    for (const d of document.querySelectorAll("dialog")) d.close();
    S.session = { authenticated: false, setupRequired: false };
    S.dirty = false;
    stopPolling();
    render();
    throw new ApiError("Your session expired. Sign in again.", 401);
  }
  if (!res.ok) throw new ApiError(data?.error?.message || `Request failed (HTTP ${res.status})`, res.status);
  return data;
}

function toast(message, kind = "info") {
  const el = h("div", { class: `toast ${kind === "error" ? "error" : ""}` }, message);
  toasts.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3000);
}

/** Run an async action with a busy button and error toast. The label stays so the button keeps its width. */
async function act(button, fn) {
  if (button) {
    button.disabled = true;
    button.classList.add("busy");
  }
  try {
    return await fn();
  } catch (err) {
    toast(err.message, "error");
    throw err;
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("busy");
    }
  }
}

const nf = new Intl.NumberFormat();
function fmtNum(n) {
  n = n || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return nf.format(n);
}

function relTime(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function uptime(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}

const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDate = (iso) => new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
const fmtMs = (ms) => (ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

/**
 * Copy text (or a promise of it) to the clipboard. Returns true once the user has it:
 * copied, or, where the browser has no clipboard API, shown selected to copy by hand.
 */
async function copy(text, button) {
  try {
    if (!navigator.clipboard) throw new Error("no clipboard API");
    if (typeof text !== "string" && window.ClipboardItem) {
      // Safari only copies asynchronously fetched text when the promise is handed over within the click.
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
    } else {
      await navigator.clipboard.writeText(await text);
    }
    if (button) {
      const label = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = label), 1500);
    }
    return true;
  } catch {
    // Plain http on a tailnet IP isn't a secure context, so there's no clipboard API there.
    let value;
    try {
      value = await text;
    } catch (err) {
      toast(err.message, "error");
      return false;
    }
    const pre = h("pre", { class: "codeblock" }, value);
    const d = openDialog({
      title: "Copy this",
      body: [pre, h("p", { class: "muted small" }, `The browser blocked the clipboard here. Press ${navigator.platform.startsWith("Mac") ? "⌘C" : "Ctrl+C"} to copy the selected text.`)],
      actions: [h("button", { class: "primary", onclick: () => d.close() }, "Done")]
    });
    getSelection().selectAllChildren(pre);
    return true;
  }
}

function currentTab() {
  const tab = location.hash.replace(/^#\/?/, "");
  return TABS.some(([id]) => id === tab) ? tab : "overview";
}

/** Cached model list for a connection. */
function providerModels(id, refresh = false) {
  if (!id) return Promise.resolve({ ok: false, models: [], error: "" });
  if (refresh || !S.models.has(id)) {
    S.models.set(id, api("GET", `/providers/${id}/models`).catch((err) => ({ ok: false, models: [], error: err.message })));
  }
  return S.models.get(id);
}

const isFailure = (e) => e.status >= 400 || Boolean(e.error);

/**
 * Health of a connection, from its latest request and last explicit test.
 * ponytail: the gateway doesn't probe providers; add a periodic check if this proves too stale.
 */
function health(p) {
  const test = S.tests.get(p.id);
  // Newest request that this connection served, or was passed over in as a fallback.
  const last = S.activity.find((e) => e.provider === p.name || e.fallbacks?.some((f) => f.startsWith(`${p.name} / `)));
  if (test && (!last || test.at > new Date(last.time).getTime())) {
    return test.ok ? { level: "ok", text: `${test.latencyMs} ms · ${test.models.length} models` } : { level: "down", text: test.error };
  }
  if (!last) return { level: "none", text: "no requests yet" };
  if (last.provider !== p.name) {
    const why = last.fallbacks.find((f) => f.startsWith(`${p.name} / `));
    return /429|rate-limited|402/.test(why) ? { level: "warn", text: `rate-limited · using fallback` } : { level: "down", text: `failing · using fallback` };
  }
  if (last.status === 429) return { level: "warn", text: `rate-limited ${relTime(last.time)}` };
  if (last.status >= 500 || (last.error && !last.status)) return { level: "down", text: `failing · ${relTime(last.time)}` };
  return { level: "ok", text: `ok · ${relTime(last.time)}` };
}

const dot = (level) => h("span", { class: `dot ${level}`, "aria-hidden": "true" });

// ── Dialogs ────────────────────────────────────────────────────────────────

function openDialog({ title, body, actions, onClose, className }) {
  const dialog = h(
    "dialog",
    { "aria-label": title, class: className },
    title && h("div", { class: "dialog-head" }, h("h2", {}, title)),
    h("div", { class: "dialog-body" }, body),
    actions && h("div", { class: "dialog-foot" }, actions)
  );
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
  });
  // A backdrop click closes it like Esc does, so a "cancel" listener can veto both.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog && dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close: () => dialog.close() };
}

function confirmDialog({ title, message, confirmLabel }) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h("button", { class: "primary", onclick: () => ((result = true), d.close()) }, confirmLabel);
    const d = openDialog({
      title,
      body: h("p", {}, message),
      actions: [h("button", { onclick: () => d.close() }, "Cancel"), ok],
      onClose: () => resolve(result)
    });
    ok.focus();
  });
}

// ── Menus (connection dropdown, model combobox) ────────────────────────────

let openMenu = null; // { root, close }

document.addEventListener("pointerdown", (e) => {
  if (openMenu && !openMenu.root.contains(e.target)) openMenu.close();
});

function closeMenus() {
  openMenu?.close();
}

/**
 * A button that opens a listbox. options: [{ value, label, level, meta }].
 * Returns { el, button, get(), set(value) }.
 */
function selectMenu({ value, options, label, onPick }) {
  let current = value ?? "";
  const name = h("span", { class: "grow" });
  const dotEl = h("span");
  const button = h("button", { type: "button", class: "dd-button", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": label }, dotEl, name, chevron());
  const menu = h("div", { class: "menu", role: "listbox", hidden: true });
  const root = h("div", { class: "dd" }, button, menu);

  let dotRef = dotEl;
  const paintDot = (level) => {
    const next = dot(level);
    dotRef.replaceWith(next);
    dotRef = next;
  };
  const repaint = () => {
    const opt = options.find((o) => o.value === current);
    name.textContent = opt ? opt.label : "Choose a connection";
    name.classList.toggle("placeholder", !opt);
    paintDot(opt?.level || "none");
  };

  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    root.closest(".rule")?.classList.remove("lift");
    if (openMenu?.root === root) openMenu = null;
  };
  const pick = (v) => {
    const changed = v !== current;
    current = v;
    repaint();
    close();
    button.focus();
    if (changed) onPick?.(v);
  };
  const open = () => {
    closeMenus();
    menu.replaceChildren(
      ...options.map((o) =>
        h(
          "button",
          { type: "button", role: "option", class: `menu-item ${o.value === current ? "selected" : ""}`, "aria-selected": String(o.value === current), onclick: () => pick(o.value) },
          dot(o.level || "none"),
          h("span", { class: "grow" }, o.label),
          o.meta ? h("span", { class: "count" }, o.meta) : null
        )
      )
    );
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    root.closest(".rule")?.classList.add("lift");
    openMenu = { root, close };
    (menu.querySelector(".selected") || menu.firstChild)?.focus();
  };
  button.addEventListener("click", () => (menu.hidden ? open() : close()));
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll(".menu-item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") items[Math.min(i + 1, items.length - 1)]?.focus();
    else if (e.key === "ArrowUp") items[Math.max(i - 1, 0)]?.focus();
    else if (e.key === "Escape") (close(), button.focus());
    else return;
    e.preventDefault();
  });
  repaint();
  return { el: root, button, get: () => current };
}

/**
 * A searchable model field. Free text is allowed: providers don't always list every
 * model, so whatever is typed is the value. Suggestions come from the connection.
 */
function modelCombo({ value, providerId, label, onInput }) {
  let pid = providerId;
  let active = -1;
  let filtering = false; // false until the user types, so focusing shows the whole list
  const listId = `ml-${Math.random().toString(36).slice(2)}`;
  const input = h("input", {
    class: "combo-input",
    value: value ?? "",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": listId,
    "aria-label": label,
    autocomplete: "off",
    spellcheck: "false"
  });
  const box = h("div", { class: "combo" }, searchIcon(), input, chevron());
  const menu = h("div", { class: "menu", role: "listbox", id: listId, hidden: true });
  const root = h("div", { class: "dd" }, box, menu);

  const close = () => {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    root.closest(".rule")?.classList.remove("lift");
    if (openMenu?.root === root) openMenu = null;
  };
  const choose = (m) => {
    input.value = m;
    close();
    // "change", not "input", so listeners can react without reopening the menu.
    input.dispatchEvent(new Event("change"));
    onInput?.();
  };
  const fill = async () => {
    if (!pid) return;
    const r = await providerModels(pid);
    if (menu.hidden) return;
    const q = filtering ? input.value.trim().toLowerCase() : "";
    const all = r.models || [];
    const matches = all.filter((m) => m.toLowerCase().includes(q));
    // ponytail: first 50 matches; virtualize if someone has a 5k-model provider
    const shown = matches.slice(0, 50);
    active = Math.min(active, shown.length - 1);
    const meta = !r.ok
      ? `Couldn't list models${r.error ? `: ${r.error}` : ""}. Type a name.`
      : q
        ? `${matches.length} match${matches.length === 1 ? "" : "es"} of ${all.length}`
        : `${all.length} models${all.length > shown.length ? " · type to filter" : ""}`;
    menu.replaceChildren(
      h("div", { class: "menu-meta" }, meta),
      ...shown.map((m, i) =>
        h(
          "div",
          {
            id: `${listId}-${i}`,
            role: "option",
            class: `menu-item mono ${m === input.value.trim() ? "selected" : ""} ${i === active ? "active" : ""}`,
            "aria-selected": String(m === input.value.trim()),
            // mousedown, so the input doesn't blur first
            onmousedown: (e) => (e.preventDefault(), choose(m))
          },
          h("span", { class: "grow" }, m),
          m === input.value.trim() ? checkIcon() : null
        )
      )
    );
    if (active >= 0) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  };
  const open = () => {
    if (input.disabled || !pid) return;
    if (openMenu?.root !== root) closeMenus();
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    root.closest(".rule")?.classList.add("lift");
    openMenu = { root, close };
    fill();
  };
  input.addEventListener("focus", () => ((filtering = false), (active = -1), open()));
  input.addEventListener("click", open);
  input.addEventListener("input", () => {
    filtering = true;
    active = -1;
    open();
    onInput?.();
  });
  input.addEventListener("blur", () => setTimeout(() => !root.contains(document.activeElement) && close(), 0));
  input.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll(".menu-item")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (menu.hidden) open();
      active = e.key === "ArrowDown" ? Math.min(active + 1, items.length - 1) : Math.max(active - 1, 0);
      items.forEach((el, i) => el.classList.toggle("active", i === active));
      items[active]?.scrollIntoView({ block: "nearest" });
      if (items[active]) input.setAttribute("aria-activedescendant", items[active].id);
    } else if (e.key === "Enter" && !menu.hidden) {
      if (items[active]) choose(items[active].textContent);
      else close();
    } else if (e.key === "Escape" && !menu.hidden) {
      close();
    } else return;
    e.preventDefault();
  });
  box.addEventListener("click", (e) => e.target !== input && input.focus());

  return {
    el: root,
    input,
    get: () => input.value.trim(),
    /** Point at another connection (or none). */
    setProvider(id, { placeholder, disabled } = {}) {
      pid = id;
      input.disabled = Boolean(disabled) || !id;
      input.placeholder = placeholder || (id ? "search models" : "pick a connection first");
      box.classList.toggle("disabled", input.disabled);
      close();
    }
  };
}

// ── Data ───────────────────────────────────────────────────────────────────

async function loadState() {
  S.data = await api("GET", "/state");
}

async function loadActivity() {
  S.activity = (await api("GET", "/activity")).entries;
}

function startPolling() {
  stopPolling();
  S.pollTimer = setInterval(async () => {
    if (document.hidden || currentTab() !== "overview" || document.querySelector("dialog[open]")) return;
    // Don't redraw under someone who is selecting text.
    if (String(window.getSelection?.() || "")) return;
    try {
      await Promise.all([loadState(), loadActivity()]);
      renderShell();
    } catch {}
  }, 5000);
}

function stopPolling() {
  clearInterval(S.pollTimer);
  S.pollTimer = null;
}

// ── Auth screens ───────────────────────────────────────────────────────────

function brand() {
  return h("div", { class: "brand" }, h("img", { class: "logo", src: "/admin/favicon.svg", alt: "" }), h("span", {}, "Claude Gateway"));
}

/** Password managers need a username field to save the password against. */
const usernameField = () => h("input", { type: "text", name: "username", autocomplete: "username", value: "admin", hidden: true, tabindex: "-1", "aria-hidden": "true" });

function authPage(...content) {
  app.replaceChildren(h("div", { class: "auth" }, h("div", { class: "auth-card" }, brand(), content)));
}

function renderSetup() {
  const code = h("input", { class: "mono", autocomplete: "one-time-code", placeholder: "XXXX-XXXX", required: true });
  const pw = h("input", { type: "password", autocomplete: "new-password", minlength: "10", required: true, "aria-describedby": "setup-pw-rule" });
  const pw2 = h("input", { type: "password", autocomplete: "new-password", required: true });
  const error = h("p", { class: "field-error", hidden: true, role: "alert" });
  const submit = h("button", { class: "primary", type: "submit" }, "Set password and continue");
  const form = h(
    "form",
    {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        if (pw.value !== pw2.value) {
          error.textContent = "Passwords don't match";
          error.hidden = false;
          return;
        }
        try {
          await act(submit, () => api("POST", "/setup", { code: code.value, password: pw.value }));
          await boot();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      }
    },
    usernameField(),
    h("label", {}, "Setup code", code),
    h("label", {}, "Admin password", pw, h("span", { class: "hint", id: "setup-pw-rule" }, "10 characters or more")),
    h("label", {}, "Confirm password", pw2),
    error,
    submit
  );
  authPage(
    h("div", {}, h("h1", {}, "Set up admin access"), h("p", { class: "muted" }, "The setup code is printed once in the gateway log.")),
    h("pre", { class: "codeblock" }, 'journalctl -u claude-gateway | grep "setup code"\ndocker compose logs gateway | grep "setup code"'),
    form
  );
  code.focus();
}

function renderLogin() {
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true });
  const error = h("p", { class: "field-error", hidden: true, role: "alert" });
  const submit = h("button", { class: "primary", type: "submit" }, "Sign in");
  const form = h(
    "form",
    {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        try {
          await act(submit, () => api("POST", "/login", { password: pw.value }));
          await boot();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          pw.select();
        }
      }
    },
    usernameField(),
    h("label", {}, "Admin password", pw),
    error,
    submit
  );
  authPage(h("div", {}, h("h1", {}, "Sign in"), h("p", { class: "muted small" }, "Sessions end when the gateway restarts.")), form);
  pw.focus();
}

// ── Shell ──────────────────────────────────────────────────────────────────

function worst(levels) {
  for (const l of ["down", "warn", "ok"]) if (levels.includes(l)) return l;
  return "none";
}

function navInfo() {
  const d = S.data;
  const r = d.routes;
  const activeKeys = d.clientKeys.filter((k) => !k.revokedAt).length;
  const ruleCount = r.models.length + r.overrides.length + FAMILIES.filter(([f]) => r[f]).length + (r.default ? 1 : 0);
  return {
    overview: { count: "", level: S.activity.slice(0, 20).some(isFailure) ? "warn" : "ok" },
    connections: { count: d.providers.length || "", level: d.providers.length ? worst(d.providers.map((p) => health(p).level)) : "warn" },
    routing: { count: ruleCount || "", level: r.default ? "ok" : "warn" },
    keys: { count: activeKeys || "", level: d.server.openMode ? "warn" : activeKeys ? "ok" : "down" },
    settings: { count: "", level: null } // nothing to report, so no dot
  };
}

function renderShell() {
  const tab = currentTab();
  S.tab = tab;
  const info = navInfo();
  const s = S.data.server;
  const signOut = h("button", { class: "ghost small rail-signout", onclick: () => logout(signOut) }, "Sign out");
  app.replaceChildren(
    h(
      "div",
      { class: "shell" },
      h(
        "nav",
        { class: "rail", "aria-label": "Sections" },
        brand(),
        h("button", { class: "jump", onclick: openPalette, "aria-keyshortcuts": "Meta+K Control+K" }, h("span", {}, "Jump to…"), h("kbd", {}, navigator.platform.startsWith("Mac") ? "⌘K" : "Ctrl K")),
        TABS.map(([id, label]) =>
          h("a", { href: `#/${id}`, class: "nav-item", "aria-current": id === tab ? "page" : null }, info[id].level ? dot(info[id].level) : h("span", { class: "dot-space", "aria-hidden": "true" }), h("span", { class: "grow" }, label), h("span", { class: "count" }, info[id].count))
        ),
        h(
          "div",
          { class: "rail-foot" },
          h("div", { class: "row" }, dot("ok"), h("span", {}, `Up ${uptime(S.data.stats.startedAt)} · v${s.version}`)),
          h("div", { class: "mono muted tiny" }, `${s.host}:${s.port} · ${s.adminAllowFrom === "local" ? "local + tailnet" : "any address"}`),
          signOut
        )
      ),
      h("main", { id: "main", class: "content" })
    )
  );
  renderMain();
}

function renderMain() {
  const main = document.getElementById("main");
  if (!main || !S.data) return;
  const views = { overview: viewOverview, connections: viewConnections, routing: viewRouting, keys: viewKeys, settings: viewSettings };
  main.replaceChildren(views[currentTab()]());
}

/** Reload state and redraw, keeping the rail's counts in step. */
async function refresh() {
  await loadState();
  renderShell();
}

function pageHead(title, subtitle, ...actions) {
  return h("div", { class: "page-head" }, h("div", {}, h("h1", {}, title), subtitle && h("p", { class: "muted" }, subtitle)), actions.length ? h("div", { class: "row" }, actions) : null);
}

function notice(kind, ...content) {
  return h("div", { class: `notice ${kind}`, role: kind === "danger" ? "alert" : null }, h("div", {}, content));
}

function setupNotices() {
  const d = S.data;
  const out = [];
  if (!d.providers.length) out.push(notice("warn", "No connections yet. ", h("a", { href: "#/connections" }, "Add your first provider"), " so Claude Code has somewhere to go."));
  else if (!d.routes.default) out.push(notice("warn", "No default route. ", h("a", { href: "#/routing" }, "Pick a default connection and model"), "."));
  for (const p of d.providers) {
    const hl = health(p);
    if (hl.level === "down") out.push(notice("danger", h("strong", {}, `${p.name} is failing. `), `Routes that use it (${routesUsing(p.id).join(", ") || "none"}) will error. `, h("a", { href: "#/connections" }, "Open connections"), "."));
  }
  if (d.server.openMode) {
    out.push(notice("warn", "No client keys exist, so anything on this machine can use the gateway without a key. ", h("a", { href: "#/keys" }, "Create a client key"), " to require one."));
  } else if (!d.clientKeys.some((k) => !k.revokedAt)) {
    out.push(notice("danger", "No active client keys: every Claude Code request is being rejected. ", h("a", { href: "#/keys" }, "Create a client key"), "."));
  }
  return out;
}

async function logout(button) {
  await act(button, () => api("POST", "/logout"));
  S.session = { authenticated: false, setupRequired: false };
  S.dirty = false;
  stopPolling();
  render();
}

// ── Command palette ────────────────────────────────────────────────────────

function openPalette() {
  if (document.querySelector("dialog[open]")) return;
  const commands = [
    ...TABS.map(([id, label]) => ({ label: `Go to ${label}`, hint: "page", run: () => (location.hash = `#/${id}`) })),
    { label: "Add connection", hint: "action", run: () => ((location.hash = "#/connections"), providerDialog()) },
    { label: "Create client key", hint: "action", run: () => ((location.hash = "#/keys"), createKeyDialog()) },
    { label: "Test a model name", hint: "action", run: () => ((location.hash = "#/routing"), setTimeout(() => document.getElementById("resolve-input")?.focus(), 0)) },
    { label: "Sign out", hint: "action", run: () => logout() }
  ];
  const input = h("input", { class: "palette-input", placeholder: "Type a page or action…", "aria-label": "Search commands", role: "combobox", "aria-expanded": "true", "aria-controls": "palette-list" });
  const list = h("div", { class: "palette-list", id: "palette-list", role: "listbox" });
  let active = 0;
  let shown = commands;
  const run = (c) => {
    d.close();
    // Let the dialog close before a command opens another one.
    setTimeout(c.run, 0);
  };
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    shown = commands.filter((c) => c.label.toLowerCase().includes(q));
    active = Math.min(active, Math.max(shown.length - 1, 0));
    list.replaceChildren(
      ...(shown.length
        ? shown.map((c, i) =>
            h("button", { type: "button", role: "option", class: `palette-item ${i === active ? "active" : ""}`, "aria-selected": String(i === active), onclick: () => run(c) }, h("span", {}, c.label), h("span", { class: "muted mono tiny" }, c.hint))
          )
        : [h("p", { class: "muted palette-empty" }, "Nothing matches.")])
    );
  };
  input.addEventListener("input", () => ((active = 0), paint()));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") active = Math.min(active + 1, shown.length - 1);
    else if (e.key === "ArrowUp") active = Math.max(active - 1, 0);
    else if (e.key === "Enter") return shown[active] && (e.preventDefault(), run(shown[active]));
    else return;
    e.preventDefault();
    paint();
  });
  paint();
  const d = openDialog({ title: null, body: [input, list], className: "palette" });
  input.focus();
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && S.session?.authenticated) {
    e.preventDefault();
    openPalette();
  }
});

// ── Overview ───────────────────────────────────────────────────────────────

function viewOverview() {
  const d = S.data;
  const t = d.stats;
  const stat = (label, value, bad) => h("div", { class: "stat" }, h("div", { class: "label" }, label), h("div", { class: `value ${bad ? "bad" : ""}` }, value));

  const keyNames = [...new Set(S.activity.map((e) => e.keyName).filter(Boolean))];
  const chip = (id, label) =>
    h("button", { class: `chip ${S.filter === id ? "on" : ""}`, "aria-pressed": String(S.filter === id), onclick: () => ((S.filter = id), renderMain()) }, label);
  const entries = S.activity.filter((e) => (S.filter === "all" ? true : S.filter === "errors" ? isFailure(e) : e.keyName === S.filter));

  const rows = entries.map((e) => {
    const failed = isFailure(e);
    const aborted = e.error && e.status < 400;
    const open = S.openRow === e.id;
    return h(
      "div",
      { class: "req-wrap" },
      h(
        "button",
        { class: `gr req req-button ${e.status >= 400 ? "err" : ""}`, "aria-expanded": String(open), onclick: () => ((S.openRow = open ? null : e.id), renderMain()) },
        h("span", { class: "mono muted" }, fmtTime(e.time)),
        h("span", { class: "ellipsis" }, e.keyName || "—"),
        h("span", { class: "ellipsis" }, h("span", { class: "mono" }, e.model || "—"), e.provider ? h("span", { class: "muted" }, ` → ${e.provider} / ${e.upstreamModel}`) : null),
        h("span", {}, h("span", { class: `pill ${e.status >= 400 ? "bad" : aborted ? "warn" : "ok"}` }, aborted ? "aborted" : e.status || "error"), e.droppedParams?.length ? h("span", { class: "pill acc retry" }, "retried") : null, e.fallbacks?.length ? h("span", { class: "pill warn retry" }, "fallback") : null),
        h("span", { class: "mono muted hide-sm" }, e.stopReason || "—"),
        h("span", { class: "num" }, fmtNum(e.inputTokens)),
        h("span", { class: "num" }, fmtNum(e.outputTokens)),
        h("span", { class: "num" }, fmtMs(e.durationMs))
      ),
      open &&
        h(
          "dl",
          { class: "req-detail" },
          h("div", {}, h("dt", {}, "Result"), h("dd", { class: failed ? "bad-text" : null }, e.error || "Completed normally")),
          h("div", {}, h("dt", {}, "Served by"), h("dd", {}, e.provider ? `${e.provider} / ${e.upstreamModel}` : "—")),
          h("div", {}, h("dt", {}, "Time to first token"), h("dd", {}, fmtMs(e.ttftMs))),
          h("div", {}, h("dt", {}, "Retried without"), h("dd", {}, e.droppedParams?.length ? e.droppedParams.join(", ") : "nothing")),
          e.fallbacks?.length ? h("div", { class: "wide" }, h("dt", {}, "Fell back from"), e.fallbacks.map((f) => h("dd", {}, f))) : null
        )
    );
  });

  return h(
    "div",
    { class: "stack" },
    pageHead("Overview", `Counters are in memory and reset when the gateway restarts (started ${relTime(t.startedAt)}).`, h("span", { class: "pill ok" }, dot("ok"), "live · 5 s")),
    setupNotices(),
    h("div", { class: "stats" }, stat("Requests", fmtNum(t.requests)), stat("Errors", fmtNum(t.errors), t.errors > 0), stat("Input tokens", fmtNum(t.inputTokens)), stat("Output tokens", fmtNum(t.outputTokens))),
    d.providers.length
      ? h(
          "div",
          { class: "health" },
          d.providers.map((p) => {
            const hl = health(p);
            return h("a", { class: "health-card", href: "#/connections" }, h("div", { class: "row" }, dot(hl.level), h("strong", {}, p.name)), h("span", { class: "mono muted tiny" }, hl.text));
          })
        )
      : null,
    h(
      "section",
      { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Recent requests"), h("div", { class: "row" }, chip("all", "All"), chip("errors", "Errors"), keyNames.map((k) => chip(k, k)))),
      S.activity.length
        ? h(
            "div",
            { class: "scroll" },
            h(
              "div",
              { class: "grid-table" },
              h("div", { class: "gr req head" }, h("span", {}, "Time"), h("span", {}, "Key"), h("span", {}, "Model → upstream"), h("span", {}, "Status"), h("span", { class: "hide-sm" }, "Stop"), h("span", { class: "num" }, "In"), h("span", { class: "num" }, "Out"), h("span", { class: "num" }, "Total")),
              rows.length ? rows : h("p", { class: "empty" }, "Nothing matches this filter.")
            )
          )
        : h("p", { class: "empty" }, "No requests yet. Point Claude Code at this gateway and they'll show up here.")
    )
  );
}

// ── Connections ────────────────────────────────────────────────────────────

function routesUsing(id) {
  const r = S.data.routes;
  const uses = [];
  const check = (route, label) => {
    if (!route) return;
    if (route.provider === id) uses.push(label);
    if (route.fallbacks?.some((f) => f.provider === id)) uses.push(`${label} (fallback)`);
  };
  check(r.default, "default");
  for (const [f] of FAMILIES) check(r[f], f);
  for (const m of r.models) check(m, m.displayName || m.id);
  for (const o of r.overrides) check(o, o.match);
  return uses;
}

function testResultView(result) {
  if (!result) return null;
  return h(
    "div",
    { class: "test-result" },
    dot(result.ok ? "ok" : "down"),
    result.ok
      ? [h("strong", {}, "Connected"), h("span", { class: "muted mono" }, `${result.latencyMs} ms · ${result.models.length} model${result.models.length === 1 ? "" : "s"}`)]
      : [h("strong", {}, "Failed"), h("span", { class: "muted" }, result.error)]
  );
}

/** A short description of how a connection sends its key. */
function authSchemeLabel(p) {
  if (p.authScheme === "x-api-key") return "x-api-key";
  if (p.authScheme === "header") return `${p.authHeader || "api-key"} header`;
  if (p.authScheme === "none") return "none";
  return p.queryParams ? `Bearer · ?${p.queryParams}` : "Bearer";
}

function deleteProviderDialog(p) {
  const uses = routesUsing(p.id);
  if (uses.length) {
    const d = openDialog({
      title: `Delete ${p.name}?`,
      body: [notice("warn", `These routes use ${p.name}. Move them to another connection first, or they will fail with "No route".`), h("div", { class: "row" }, uses.map((u) => h("span", { class: "pill acc" }, u)))],
      actions: [
        h("button", { onclick: () => d.close() }, "Cancel"),
        h("button", { onclick: () => (d.close(), (location.hash = "#/routing")) }, "Open routing"),
        h("button", { class: "primary", disabled: true, title: "Move its routes first" }, "Delete")
      ]
    });
    return;
  }
  confirmDialog({ title: `Delete ${p.name}?`, message: "No routes use it. The connection and its API key will be removed.", confirmLabel: "Delete" }).then(async (ok) => {
    if (!ok) return;
    try {
      await api("DELETE", `/providers/${p.id}`);
    } catch (err) {
      return toast(err.message, "error");
    }
    S.models.delete(p.id);
    S.tests.delete(p.id);
    await refresh();
    toast(`Deleted ${p.name}`);
  });
}

function viewConnections() {
  const d = S.data;
  const add = h("button", { class: "primary", onclick: () => providerDialog() }, "Add connection");
  const head = pageHead("Connections", "OpenAI-compatible providers the gateway can send requests to.", d.providers.length ? add : null);
  if (!d.providers.length) {
    return h("div", { class: "stack" }, head, h("div", { class: "panel empty-panel" }, h("h2", {}, "No connections yet"), h("p", { class: "muted" }, "Add a provider like OpenAI, OpenRouter, DeepSeek or a local Ollama."), add));
  }
  return h(
    "div",
    { class: "stack" },
    head,
    h(
      "div",
      { class: "panel" },
      h(
        "div",
        { class: "scroll" },
        h(
          "div",
          { class: "grid-table" },
          h("div", { class: "gr conn head" }, h("span", {}, "Name"), h("span", {}, "Base URL"), h("span", {}, "Auth"), h("span", {}, "Health"), h("span", {}, "Used by"), h("span", {})),
          d.providers.map((p) => {
            const uses = routesUsing(p.id);
            const hl = health(p);
            const test = h(
              "button",
              {
                class: "small",
                onclick: async () => {
                  const r = await act(test, () => providerModels(p.id, true));
                  S.tests.set(p.id, { ...r, at: Date.now() });
                  renderShell();
                }
              },
              "Test"
            );
            return h(
              "div",
              { class: "conn-wrap" },
              h(
                "div",
                { class: "gr conn" },
                h("span", { class: "ellipsis" }, h("strong", {}, p.name), h("div", { class: "mono muted tiny" }, p.apiKeyMasked)),
                h("span", { class: "mono muted small break" }, p.baseUrl),
                h("span", { class: "mono small" }, authSchemeLabel(p)),
                h("span", { class: "row tight" }, dot(hl.level), h("span", { class: "mono small" }, hl.text)),
                h("span", { class: "row tight" }, uses.length ? uses.map((u) => h("span", { class: "pill acc" }, u)) : h("span", { class: "muted" }, "nothing")),
                h("span", { class: "row tight end" }, test, h("button", { class: "small", onclick: () => providerDialog(p) }, "Edit"), h("button", { class: "small danger", onclick: () => deleteProviderDialog(p) }, "Delete"))
              ),
              S.tests.get(p.id) && !S.tests.get(p.id).ok ? h("div", { class: "conn-test" }, testResultView(S.tests.get(p.id))) : null
            );
          })
        )
      )
    )
  );
}

function providerDialog(existing) {
  const isEdit = Boolean(existing);
  const needsDefault = !isEdit && !S.data.routes.default;
  const name = h("input", { value: existing?.name ?? "", required: true, maxlength: "80" });
  const baseUrl = h("input", { class: "mono", value: existing?.baseUrl ?? "", placeholder: "https://api.example.com/v1", required: true });
  const apiKey = h("input", {
    class: "mono",
    type: "password",
    autocomplete: "off",
    placeholder: isEdit ? `Unchanged (${existing.apiKeyMasked})` : "sk-…",
    required: !isEdit
  });
  const maxTokens = h("input", { type: "number", min: "1", value: existing?.maxOutputTokens ?? "", placeholder: "No limit" });
  const pattern = h("input", { class: "mono", value: existing?.reasoningPattern ?? "", placeholder: "built-in detection" });
  const authScheme = h(
    "select",
    { onchange: () => (authHeaderRow.hidden = authScheme.value !== "header") },
    AUTH_SCHEMES.map((s) => h("option", { value: s.value, selected: (existing?.authScheme ?? "bearer") === s.value }, s.label))
  );
  const authHeader = h("input", { class: "mono", value: existing?.authHeader ?? "", placeholder: "api-key" });
  const authHeaderRow = h("label", { hidden: (existing?.authScheme ?? "bearer") !== "header" }, "Auth header name", authHeader, h("span", { class: "hint" }, "Azure OpenAI uses “api-key”."));
  const queryParams = h("input", { class: "mono", value: existing?.queryParams ?? "", placeholder: "api-version=2024-10-21" });
  const parameterRetry = h("input", { type: "checkbox", checked: existing ? existing.parameterRetry !== false : true });
  const listId = `models-${Math.random().toString(36).slice(2)}`;
  const datalist = h("datalist", { id: listId });
  const defaultModel = h("input", { class: "mono", list: listId, placeholder: "e.g. gpt-4.1", required: needsDefault });
  const result = h("div");
  const error = h("p", { class: "field-error", hidden: true, role: "alert" });

  const presetChips = !isEdit
    ? h(
        "div",
        { class: "chips", role: "group", "aria-label": "Provider" },
        PRESETS.map((p) => {
          const b = h(
            "button",
            {
              type: "button",
              class: "chip",
              "aria-pressed": "false",
              onclick: () => {
                for (const c of b.parentElement.children) (c.classList.remove("on"), c.setAttribute("aria-pressed", "false"));
                b.classList.add("on");
                b.setAttribute("aria-pressed", "true");
                if (p.name && (!name.value || PRESETS.some((x) => x.name === name.value))) name.value = p.name;
                baseUrl.value = p.baseUrl;
                // Presets may also fix the auth scheme (Azure needs api-key + ?api-version=).
                authScheme.value = p.authScheme ?? "bearer";
                authHeader.value = p.authHeader ?? "";
                queryParams.value = p.queryParams ?? "";
                authHeaderRow.hidden = authScheme.value !== "header";
                (p.baseUrl ? apiKey : baseUrl).focus();
              }
            },
            p.label
          );
          return b;
        })
      )
    : null;

  const test = h(
    "button",
    {
      type: "button",
      class: "small",
      onclick: async () => {
        const r = await act(test, () =>
          api("POST", "/providers/test", { id: existing?.id, baseUrl: baseUrl.value, apiKey: apiKey.value, authScheme: authScheme.value, authHeader: authHeader.value, queryParams: queryParams.value })
        );
        result.replaceChildren(testResultView(r));
        datalist.replaceChildren(...r.models.map((m) => h("option", { value: m })));
      }
    },
    "Test connection"
  );
  const save = h("button", { class: "primary", type: "submit", form: "provider-form" }, isEdit ? "Save" : "Add connection");

  const form = h(
    "form",
    {
      id: "provider-form",
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        const body = {
          name: name.value,
          baseUrl: baseUrl.value,
          apiKey: apiKey.value,
          maxOutputTokens: maxTokens.value || null,
          reasoningPattern: pattern.value,
          authScheme: authScheme.value,
          authHeader: authHeader.value,
          queryParams: queryParams.value,
          parameterRetry: parameterRetry.checked
        };
        if (needsDefault) body.defaultModel = defaultModel.value;
        try {
          const saved = await act(save, () => (isEdit ? api("PATCH", `/providers/${existing.id}`, body) : api("POST", "/providers", body)));
          S.models.delete(saved.id);
          S.tests.delete(saved.id);
          d.close();
          await refresh();
          toast(isEdit ? `Saved ${saved.name}` : `Added ${saved.name}`);
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      }
    },
    presetChips,
    h("div", { class: "form-grid" }, h("label", {}, "Name", name), h("label", {}, "API key", apiKey)),
    h("label", {}, "Base URL", baseUrl, h("span", { class: "hint" }, "Ends before /chat/completions.")),
    h("div", { class: "form-grid" }, h("label", {}, "Auth", authScheme), h("label", {}, "Query parameters", queryParams)),
    authHeaderRow,
    needsDefault && h("label", {}, "Default model", defaultModel, datalist, h("span", { class: "hint" }, "All Claude Code requests go here until you set up routing. Test the connection to pick from a list.")),
    h(
      "details",
      { class: "advanced", open: Boolean(existing && (existing.maxOutputTokens || existing.reasoningPattern || existing.parameterRetry === false)) },
      h("summary", {}, "More: max output tokens, reasoning regex, parameter retry"),
      h(
        "div",
        { class: "form" },
        h(
          "div",
          { class: "form-grid" },
          h("label", {}, "Max output tokens", maxTokens, h("span", { class: "hint" }, "Caps Claude Code's max_tokens (gpt-4o: 16384).")),
          h("label", {}, "Reasoning models (regex)", pattern, h("span", { class: "hint" }, "Matches get max_completion_tokens and no temperature."))
        ),
        h("label", { class: "checkbox" }, parameterRetry, h("span", {}, "Retry without parameters the provider rejects (recommended)"))
      )
    ),
    h("div", { class: "row" }, test, result),
    error
  );

  const d = openDialog({
    title: isEdit ? `Edit ${existing.name}` : "Add connection",
    body: form,
    actions: [h("button", { type: "button", onclick: () => d.close() }, "Cancel"), save]
  });
  (presetChips?.firstChild || name).focus();
}

// ── Routing ────────────────────────────────────────────────────────────────

function connectionOptions({ allowInherit }) {
  const opts = S.data.providers.map((p) => {
    const hl = health(p);
    return { value: p.id, label: p.name, level: hl.level, meta: hl.level === "down" ? "failing" : hl.level === "warn" ? "rate-limited" : "" };
  });
  return allowInherit ? [{ value: "", label: "Same as default", level: "none" }, ...opts] : opts;
}

/** Connection menu + model combobox; the model's suggestions follow the connection. */
function targetEditor(route, { allowInherit = false, label = "", markDirty, onConnChange }) {
  const model = modelCombo({ value: route?.model ?? "", providerId: route?.provider, label: `${label} upstream model`, onInput: markDirty });
  const sync = () =>
    model.setProvider(conn.get(), {
      disabled: allowInherit && !conn.get(),
      placeholder: allowInherit && !conn.get() ? "uses the default route" : undefined
    });
  const conn = selectMenu({
    value: route?.provider ?? "",
    options: connectionOptions({ allowInherit }),
    label: `${label} connection`,
    onPick: () => {
      model.input.value = "";
      sync();
      markDirty();
      onConnChange?.();
      // Choosing a connection leads straight into picking its model.
      if (conn.get()) model.input.focus();
    }
  });
  sync();
  return {
    connEl: conn.el,
    modelEl: model.el,
    modelInput: model.input,
    connValue: () => conn.get(),
    value: () => (conn.get() ? { provider: conn.get(), model: model.get() } : null)
  };
}

const MAX_FALLBACKS = 5;

/**
 * A rule's target plus its fallbacks: other connection+model pairs tried in order
 * when the one before is rate-limited, out of quota or down.
 */
function routeEditor(route, opts) {
  const fallbacks = [];
  const fbEl = h("div", { class: "fb-list" });
  const addBtn = h("button", { class: "small ghost", type: "button", onclick: () => addFallback() }, "+ Fallback");
  // "Same as default" uses the default's fallbacks, so it has none of its own.
  const syncAdd = () => {
    const inherits = !main.connValue();
    addBtn.hidden = inherits || fallbacks.length >= MAX_FALLBACKS;
    fbEl.hidden = inherits;
  };
  const main = targetEditor(route, { ...opts, onConnChange: () => syncAdd() });
  const addFallback = (f) => {
    const ed = targetEditor(f, { label: `${opts.label} fallback`, markDirty: opts.markDirty });
    const row = h(
      "div",
      { class: "gr rule fb" },
      h("span"),
      h("span", {}, h("span", { class: "pill mute" }, "fallback")),
      h("div", { class: "match muted small" }, "↳ if the one above is rate-limited or down"),
      ed.connEl,
      ed.modelEl,
      h(
        "span",
        { class: "row end" },
        h(
          "button",
          {
            class: "small ghost",
            "aria-label": "Remove fallback",
            onclick: () => {
              fallbacks.splice(fallbacks.indexOf(ed), 1);
              row.remove();
              syncAdd();
              opts.markDirty();
            }
          },
          "Remove"
        )
      )
    );
    fallbacks.push(ed);
    fbEl.append(row);
    syncAdd();
    if (!f) {
      opts.markDirty();
      ed.connEl.querySelector("button").focus();
    }
  };
  (route?.fallbacks ?? []).forEach(addFallback);
  syncAdd();
  return {
    ...main,
    fbEl,
    addBtn,
    value: () => {
      const v = main.value();
      if (!v) return null;
      const fb = fallbacks.map((f) => f.value()).filter(Boolean);
      return fb.length ? { ...v, fallbacks: fb } : v;
    }
  };
}

const KIND_PILL = { model: "acc", override: "warn", family: "mute", default: "ok" };

function viewRouting() {
  const d = S.data;
  if (!d.providers.length) {
    return h("div", { class: "stack" }, pageHead("Routing", "Rules are checked top to bottom. The first match wins."), notice("warn", "Add a connection first. ", h("a", { href: "#/connections" }, "Go to Connections"), "."));
  }
  S.dirty = false;
  const dirtyBar = h("div", { class: "dirty-bar", hidden: true, role: "status" });
  const markDirty = () => {
    S.dirty = true;
    dirtyBar.hidden = false;
  };

  const modelsGroup = h("div", { class: "rule-group" });
  const overridesGroup = h("div", { class: "rule-group" });
  const fixedGroup = h("div", { class: "rule-group" });
  const renumber = () => body.querySelectorAll(".rule .n").forEach((el, i) => (el.textContent = String(i + 1)));

  const ruleRow = (kind, matchCell, editor, onRemove) => {
    const main = h(
      "div",
      { class: "gr rule" },
      h("span", { class: "n mono muted" }),
      h("span", {}, h("span", { class: `pill ${KIND_PILL[kind]}` }, kind)),
      h("div", { class: "match" }, matchCell),
      editor.connEl,
      editor.modelEl,
      h(
        "span",
        { class: "row end" },
        editor.addBtn,
        onRemove
          ? h(
              "button",
              {
                class: "small ghost",
                "aria-label": `Remove ${kind} rule`,
                // ponytail: no confirm; nothing is lost until Save, and Discard undoes it.
                onclick: () => {
                  onRemove();
                  row.remove();
                  renumber();
                  markDirty();
                }
              },
              "Remove"
            )
          : null
      )
    );
    const row = h("div", { class: "rule-wrap" }, main, editor.fbEl);
    return row;
  };

  // ── Your models (listed in Claude Code's /model picker) ──
  const customModels = [];
  const addModel = (m) => {
    const editor = routeEditor(m, { label: "Model", markDirty });
    const name = h("input", { class: "cell-input", value: m?.displayName ?? "", placeholder: "Name in picker", "aria-label": "Name in the picker", maxlength: "80" });
    const id = h("input", { class: "cell-input mono", value: m?.id ?? "", placeholder: "claude-…", "aria-label": "Model ID", maxlength: "100" });
    const warn = h("div", { class: "warnline", hidden: true });
    const suggest = h("button", { class: "small ghost", type: "button", hidden: true }, "Use suggested ID");
    // Fill name and ID from the upstream model until the user edits them.
    let autoName = !m;
    let autoId = !m;
    name.addEventListener("input", () => ((autoName = false), markDirty()));
    id.addEventListener("input", () => ((autoId = false), markDirty()));

    // Show, as you type, when Desktop would drop this ID.
    const checkId = () => {
      const value = id.value.trim();
      const problem = value ? checkModelId(value) : "ok";
      const upstream = editor.modelInput.value.trim();
      const suggested = upstream ? suggestModelId(upstream) : "";
      suggest.hidden = problem === "ok" || !suggested || suggested === value;
      if (problem === "vendor-name") warn.textContent = `Claude Desktop drops IDs containing "${vendorToken(value)}" (Claude Code still shows it).`;
      else if (problem === "no-claude") warn.textContent = "Claude Code ignores IDs without “claude”, so it will not appear in /model.";
      else if (problem === "charset") warn.textContent = "IDs may only contain letters, digits and . _ : / -";
      else if (problem === "too-long") warn.textContent = "IDs are limited to 100 characters.";
      else warn.textContent = "";
      warn.hidden = !warn.textContent;
    };
    id.addEventListener("input", checkId);
    suggest.addEventListener("click", () => {
      id.value = suggestModelId(editor.modelInput.value.trim());
      autoId = false;
      checkId();
      markDirty();
    });
    const fromUpstream = () => {
      const upstream = editor.modelInput.value.trim();
      if (autoName) name.value = upstream;
      if (autoId) id.value = upstream ? suggestModelId(upstream) || `claude-${slug(upstream)}` : "";
      checkId();
    };
    editor.modelInput.addEventListener("input", fromUpstream);
    // Picking from the list fires "change" instead of "input".
    editor.modelInput.addEventListener("change", fromUpstream);
    // The form has no description field; carry the saved one through so a save keeps it.
    const entry = { name, id, editor, description: m?.description ?? "" };
    customModels.push(entry);
    modelsGroup.append(ruleRow("model", [h("div", { class: "match-pair" }, id, name), suggest, warn], editor, () => customModels.splice(customModels.indexOf(entry), 1)));
    // Existing rows get checked too, so a saved ID Desktop rejects is visible.
    checkId();
    if (!m) (renumber(), markDirty(), editor.connEl.querySelector("button").focus());
  };

  const overrides = [];
  const addOverride = (o) => {
    const match = h("input", { class: "cell-input mono", value: o?.match ?? "", placeholder: "claude-sonnet-4-5", "aria-label": "Model name or prefix", oninput: markDirty });
    const editor = routeEditor(o, { label: "Override", markDirty });
    const entry = { match, editor };
    overrides.push(entry);
    overridesGroup.append(ruleRow("override", match, editor, () => overrides.splice(overrides.indexOf(entry), 1)));
    if (!o) (renumber(), markDirty(), match.focus());
  };

  const families = FAMILIES.map(([fid, label]) => {
    const editor = routeEditor(d.routes[fid], { allowInherit: true, label, markDirty });
    fixedGroup.append(ruleRow("family", h("span", { class: "mono" }, fid), editor));
    return { id: fid, editor };
  });
  const def = routeEditor(d.routes.default, { label: "Default", markDirty });
  fixedGroup.append(ruleRow("default", h("span", { class: "muted" }, "everything else"), def));

  const body = h("div", {}, modelsGroup, overridesGroup, fixedGroup);
  d.routes.models.forEach((m) => addModel(m));
  d.routes.overrides.forEach((o) => addOverride(o));
  renumber();

  const save = h(
    "button",
    {
      class: "primary small",
      onclick: async () => {
        const payload = {
          default: def.value(),
          ...Object.fromEntries(families.map((f) => [f.id, f.editor.value()])),
          models: customModels.map((m) => ({ ...m.editor.value(), id: m.id.value.trim(), displayName: m.name.value.trim(), description: m.description })),
          overrides: overrides.map((o) => ({ match: o.match.value.trim(), ...o.editor.value() }))
        };
        await act(save, () => api("PUT", "/routes", payload));
        S.dirty = false;
        await refresh();
        toast("Routes saved — new requests use them immediately");
      }
    },
    "Save routes"
  );
  dirtyBar.append(
    h("span", {}, h("strong", {}, "Unsaved changes. "), h("span", { class: "muted" }, "Leaving this page will ask first.")),
    h("div", { class: "row" }, h(
      "button",
      {
        class: "small ghost",
        onclick: () => {
          S.dirty = false;
          renderMain();
        }
      },
      "Discard"
    ), save)
  );

  const tryInput = h("input", { id: "resolve-input", class: "mono", placeholder: "claude-haiku-4-5-20251001", "aria-label": "Model name to test" });
  const tryResult = h("div", { class: "test-result", "aria-live": "polite" });
  const tryBtn = h(
    "button",
    {
      type: "submit",
      onclick: async (e) => {
        e.preventDefault();
        const r = await act(tryBtn, () => api("GET", `/resolve?model=${encodeURIComponent(tryInput.value.trim())}`));
        tryResult.replaceChildren(
          ...(r
            ? [
                dot("ok"),
                h("strong", { class: "mono" }, `${r.provider} / ${r.model}`),
                h("span", { class: "muted" }, `via ${r.rule}`),
                r.fallbacks?.length ? h("span", { class: "muted mono" }, `then ${r.fallbacks.join(", then ")}`) : null
              ]
            : [dot("down"), h("span", {}, "No route — requests for this model would fail")])
        );
      }
    },
    "Check"
  );

  return h(
    "div",
    { class: "stack" },
    pageHead("Routing", "Rules are checked top to bottom. The first match wins.", h("button", { class: "small", onclick: () => addModel() }, "Add model"), h("button", { class: "small", onclick: () => addOverride() }, "Add override")),
    h(
      "section",
      { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Test a model name"), h("span", { class: "muted tiny" }, "Uses saved rules")),
      h("div", { class: "panel-body stack-sm" }, h("form", { class: "row nowrap" }, tryInput, tryBtn), tryResult)
    ),
    h(
      "section",
      { class: "panel open" },
      h("div", { class: "gr rule head" }, h("span", {}, "#"), h("span", {}, "Kind"), h("span", {}, "Match"), h("span", {}, "Connection"), h("span", {}, "Upstream model"), h("span", {})),
      body
    ),
    h("p", { class: "muted small" }, "Model rules appear in Claude Code's /model picker when ", h("code", {}, "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1"), " is set (included in the snippet when you create a client key). IDs must contain \"claude\"; restart Claude Code after changes."),
    dirtyBar
  );
}

// ── Client keys ────────────────────────────────────────────────────────────

function connectSnippet(secret) {
  return `export ANTHROPIC_BASE_URL=${location.origin}\nexport ANTHROPIC_API_KEY=${secret}\nexport CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`;
}

function createKeyDialog() {
  const name = h("input", { placeholder: "e.g. macbook, work-laptop", required: true, maxlength: "60" });
  const error = h("p", { class: "field-error", hidden: true, role: "alert" });
  const create = h("button", { class: "primary", type: "submit", form: "key-form" }, "Create key");
  const form = h(
    "form",
    {
      id: "key-form",
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { key, secret } = await act(create, () => api("POST", "/keys", { name: name.value }));
          d.close();
          await refresh();
          showSecretDialog(key.name, secret);
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      }
    },
    h("label", {}, "Device name", name, h("span", { class: "hint" }, "Shown in usage and request logs. Each key can be revoked on its own.")),
    error
  );
  const d = openDialog({ title: "Create client key", body: form, actions: [h("button", { type: "button", onclick: () => d.close() }, "Cancel"), create] });
  name.focus();
}

function showSecretDialog(name, secret) {
  const snippet = connectSnippet(secret);
  const done = h("button", { class: "primary", disabled: true, onclick: () => d.close() }, "Done");
  const pre = h("pre", { class: "codeblock" }, snippet);
  const unlock = (ok) => ok && (done.disabled = false);
  const copyKey = h("button", { class: "small", onclick: async () => unlock(await copy(secret, copyKey)) }, "Copy key");
  const copySnippet = h("button", { class: "small", onclick: async () => unlock(await copy(snippet, copySnippet)) }, "Copy snippet");
  const d = openDialog({
    title: `Key for ${name}`,
    body: [
      notice("warn", "This is the only time the key is shown. It's stored as a hash."),
      pre,
      h("div", { class: "row" }, copySnippet, copyKey, h("span", { class: "muted small" }, "Done unlocks after you copy."))
    ],
    actions: [done]
  });
  // Esc would throw the secret away too.
  d.dialog.addEventListener("cancel", (e) => done.disabled && e.preventDefault());
}

function renameKeyDialog(k) {
  const name = h("input", { value: k.name, required: true, maxlength: "60", "aria-label": "Device name" });
  const error = h("p", { class: "field-error", hidden: true, role: "alert" });
  const save = h("button", { class: "primary", type: "submit", form: "rename-form" }, "Save");
  const form = h(
    "form",
    {
      id: "rename-form",
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await act(save, () => api("PATCH", `/keys/${k.id}`, { name: name.value }));
          d.close();
          await refresh();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      }
    },
    h("label", {}, "Device name", name, h("span", { class: "hint" }, "Past requests keep the name they were made under.")),
    error
  );
  const d = openDialog({ title: `Rename ${k.name}`, body: form, actions: [h("button", { type: "button", onclick: () => d.close() }, "Cancel"), save] });
  name.select();
}

function viewKeys() {
  const d = S.data;
  const create = h("button", { class: "primary", onclick: createKeyDialog }, "Create key");
  const keys = [...d.clientKeys].sort((a, b) => Boolean(a.revokedAt) - Boolean(b.revokedAt) || b.createdAt.localeCompare(a.createdAt));

  const rows = keys.map((k) => {
    const revoke = h(
      "button",
      {
        class: "small danger",
        onclick: async () => {
          if (!(await confirmDialog({ title: `Revoke ${k.name}?`, message: "Claude Code on that device stops working right away. Usage history is kept; you can delete it afterwards.", confirmLabel: "Revoke" }))) return;
          await act(revoke, () => api("POST", `/keys/${k.id}/revoke`));
          await refresh();
          toast(`Revoked ${k.name}`);
        }
      },
      "Revoke"
    );
    const del = h(
      "button",
      {
        class: "small ghost",
        onclick: async () => {
          if (!(await confirmDialog({ title: `Delete ${k.name}?`, message: "Removes the key and its usage history.", confirmLabel: "Delete" }))) return;
          await act(del, () => api("DELETE", `/keys/${k.id}`));
          await refresh();
        }
      },
      "Delete"
    );
    return h(
      "div",
      { class: `gr keys ${k.revokedAt ? "revoked" : ""}` },
      h(
        "span",
        { class: "ellipsis" },
        h("button", { class: "key-name", title: "Rename", "aria-label": `Rename ${k.name}`, onclick: () => renameKeyDialog(k) }, k.name),
        h("div", { class: "mono muted tiny" }, `${k.prefix}…`)
      ),
      h("span", { class: "muted hide-sm" }, fmtDate(k.createdAt)),
      h("span", {}, relTime(k.lastUsedAt)),
      h("span", { class: "num" }, fmtNum(k.usage.requests)),
      h("span", { class: "num muted hide-sm" }, `${fmtNum(k.usage.inputTokens)} / ${fmtNum(k.usage.outputTokens)}`),
      h("span", {}, h("span", { class: `pill ${k.revokedAt ? "mute" : "ok"}` }, k.revokedAt ? "revoked" : "active")),
      h(
        "span",
        { class: "row end tight" },
        !k.revokedAt &&
          (() => {
            const b = h(
              "button",
              {
                class: "small",
                disabled: !k.copyable,
                title: k.copyable ? `Copy the setup lines for ${k.name}` : "Made before keys were kept, so it can't be shown again. Create a new key for this device.",
                onclick: () => copy(api("GET", `/keys/${k.id}/secret`).then((r) => connectSnippet(r.secret)), b)
              },
              "Copy"
            );
            return b;
          })(),
        k.revokedAt ? del : revoke
      )
    );
  });

  return h(
    "div",
    { class: "stack" },
    pageHead("Client keys", "What each device sends as ANTHROPIC_API_KEY. One per device so you can revoke them separately.", keys.length ? create : null),
    d.server.openMode && notice("warn", "No client keys yet, so anything on this machine can use the gateway without one. Once you create a key, every request needs a key."),
    keys.length
      ? h(
          "div",
          { class: "panel" },
          h(
            "div",
            { class: "scroll" },
            h(
              "div",
              { class: "grid-table" },
              h("div", { class: "gr keys head" }, h("span", {}, "Name"), h("span", { class: "hide-sm" }, "Created"), h("span", {}, "Last used"), h("span", { class: "num" }, "Requests"), h("span", { class: "num hide-sm" }, "Tokens in / out"), h("span", {}, "Status"), h("span", {})),
              rows
            )
          )
        )
      : h("div", { class: "panel empty-panel" }, h("h2", {}, "No client keys"), h("p", { class: "muted" }, "Create one key per device so you can see usage and revoke them separately."), create),
    connectPanel()
  );
}

/** How to point Claude Code at this gateway, with this gateway's own address filled in. */
function connectPanel() {
  const snippet = connectSnippet("cgw_…");
  const copyBtn = h("button", { class: "small", onclick: () => copy(snippet, copyBtn) }, "Copy");
  return h(
    "section",
    { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, "Connect Claude Code"), copyBtn),
    h(
      "div",
      { class: "panel-body stack-sm" },
      h("pre", { class: "codeblock" }, snippet),
      h(
        "p",
        { class: "muted small" },
        "Use Copy beside a key to get these lines with that key filled in, then paste them on the device. To keep them, add them to ",
        h("code", {}, "~/.zshrc"),
        " or ",
        h("code", {}, "~/.bashrc"),
        ". Discovery lists your Routing models in Claude Code's /model picker."
      )
    )
  );
}

// ── Settings ───────────────────────────────────────────────────────────────

function viewSettings() {
  const s = S.data.server;
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: "10", required: true, "aria-describedby": "pw-rule" });
  const next2 = h("input", { type: "password", autocomplete: "new-password", required: true });
  const error = h("p", { class: "field-error", hidden: true, role: "alert" });
  const save = h("button", { class: "primary", type: "submit" }, "Change password");
  const form = h(
    "form",
    {
      class: "form narrow",
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        if (next.value !== next2.value) {
          error.textContent = "Passwords don't match";
          error.hidden = false;
          return;
        }
        try {
          await act(save, () => api("POST", "/password", { next: next.value }));
          next.value = next2.value = "";
          toast("Password changed. Other sessions were signed out.");
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      }
    },
    usernameField(),
    h("div", { class: "form-grid" }, h("label", {}, "New password", next, h("span", { class: "hint", id: "pw-rule" }, "10 characters or more")), h("label", {}, "Confirm new password", next2)),
    error,
    h("div", {}, save)
  );
  const info = (label, value, env) => h("div", {}, h("dt", {}, label), h("dd", {}, value), env ? h("span", { class: "env" }, env) : null);
  return h(
    "div",
    { class: "stack" },
    pageHead("Settings", "Admin password and server facts."),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Admin password")), h("div", { class: "panel-body" }, form)),
    h(
      "section",
      { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Server"), h("span", { class: "muted tiny" }, "Read-only; set by environment variables")),
      h(
        "dl",
        { class: "facts" },
        info("Version", s.version),
        info("Listening on", `${s.host}:${s.port}`, "HOST · PORT"),
        info("Admin access", s.adminAllowFrom === "local" ? "Local networks and Tailscale" : "Any address", `ADMIN_ALLOW_FROM=${s.adminAllowFrom}`),
        info("Data file", s.dataFile, "DATA_DIR")
      )
    )
  );
}

// ── Boot ───────────────────────────────────────────────────────────────────

function render() {
  if (!S.session) return;
  if (S.session.setupRequired) return renderSetup();
  if (!S.session.authenticated) return renderLogin();
  renderShell();
}

/**
 * Test every connection in the background, so health is known on arrival rather than
 * only after traffic (activity starts empty after each gateway restart).
 */
function checkConnections() {
  for (const p of S.data.providers) {
    providerModels(p.id, true).then((r) => {
      S.tests.set(p.id, { ...r, at: Date.now() });
      // Redraw only when it can't wipe anything: no dialog, no Routing edits, no field being typed in.
      const busy = document.querySelector("dialog[open]") || S.tab === "routing" || document.activeElement?.matches("input, select, textarea");
      if (S.session?.authenticated && !busy) renderShell();
    });
  }
}

async function boot() {
  try {
    S.session = await api("GET", "/session");
    if (S.session.authenticated) {
      await Promise.all([loadState(), loadActivity()]);
      startPolling();
    }
    render();
    if (S.session.authenticated) checkConnections();
  } catch (err) {
    app.replaceChildren(h("div", { class: "auth" }, h("div", { class: "auth-card" }, notice("danger", `Couldn't reach the gateway: ${err.message}`), h("button", { class: "primary", onclick: boot }, "Try again"))));
  }
}

window.addEventListener("hashchange", async () => {
  if (!S.session?.authenticated) return;
  // Leaving Routing with unsaved edits asks first; staying puts the URL back.
  if (S.dirty && S.tab === "routing" && currentTab() !== "routing") {
    const leave = await confirmDialog({ title: "Discard routing changes?", message: "Your edits to routing haven't been saved.", confirmLabel: "Discard" });
    if (!leave) {
      history.replaceState(null, "", "#/routing");
      return;
    }
    S.dirty = false;
  }
  closeMenus();
  renderShell();
  if (currentTab() === "overview") loadActivity().then(renderShell).catch(() => {});
});

window.addEventListener("beforeunload", (e) => {
  if (S.dirty) e.preventDefault();
});

boot();
