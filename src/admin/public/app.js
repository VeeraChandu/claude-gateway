// Gateway admin UI. Vanilla JS, no build step. All DOM is built with
// createElement + text nodes (via h()), never from HTML strings, so server data
// can't inject markup.

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
  { label: "Venice", name: "Venice", baseUrl: "https://api.venice.ai/api/v1" },
  { label: "DeepSeek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { label: "Groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { label: "OpenRouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "Ollama (local)", name: "Ollama", baseUrl: "http://localhost:11434/v1" },
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
  if (res.status === 401 && !["/login", "/setup", "/password"].includes(path)) {
    // Session expired (e.g. gateway restarted): drop any open dialog and show sign-in.
    for (const d of document.querySelectorAll("dialog")) d.close();
    S.session = { authenticated: false, setupRequired: false };
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

/** Run an async action with a busy button and error toast. */
async function act(button, fn) {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Working…";
  }
  try {
    return await fn();
  } catch (err) {
    toast(err.message, "error");
    throw err;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
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

const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDate = (iso) => new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
const fmtMs = (ms) => (ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const label = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = label), 1500);
    }
  } catch {
    toast("Copy failed — select the text and copy it manually", "error");
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

// ── Dialogs ────────────────────────────────────────────────────────────────

function openDialog({ title, body, actions, onClose }) {
  const dialog = h(
    "dialog",
    { "aria-label": title },
    h("div", { class: "dialog-head" }, h("h2", {}, title)),
    h("div", { class: "dialog-body" }, body),
    h("div", { class: "dialog-foot" }, actions)
  );
  const close = () => {
    dialog.close();
  };
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
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
    try {
      await Promise.all([loadState(), loadActivity()]);
      renderMain();
    } catch {}
  }, 5000);
}

function stopPolling() {
  clearInterval(S.pollTimer);
  S.pollTimer = null;
}

// ── Auth screens ───────────────────────────────────────────────────────────

function brand() {
  return h("div", { class: "brand" }, h("img", { src: "/admin/favicon.svg", alt: "" }), h("span", {}, "Claude Gateway"));
}

/** Password managers need a username field to save the password against. */
const usernameField = () => h("input", { type: "text", name: "username", autocomplete: "username", value: "admin", hidden: true, tabindex: "-1", "aria-hidden": "true" });

function renderSetup() {
  const code = h("input", { class: "mono", autocomplete: "one-time-code", placeholder: "XXXX-XXXX", required: true });
  const pw = h("input", { type: "password", autocomplete: "new-password", minlength: "10", required: true });
  const pw2 = h("input", { type: "password", autocomplete: "new-password", required: true });
  const error = h("p", { class: "field-error", hidden: true });
  const submit = h("button", { class: "primary", type: "submit" }, "Set password");
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
    h("label", {}, "Setup code", h("span", { class: "hint" }, "Printed in the gateway log when it started without an admin password."), code),
    h("label", {}, "Admin password", h("span", { class: "hint" }, "At least 10 characters."), pw),
    h("label", {}, "Confirm password", pw2),
    error,
    submit
  );
  app.replaceChildren(
    h("div", { class: "auth" }, h("div", { class: "card" }, h("div", { class: "card-body" }, brand(), h("div", {}, h("h1", {}, "Set up admin access"), h("p", { class: "muted" }, "Choose the password for this gateway's admin page.")), form)))
  );
  code.focus();
}

function renderLogin() {
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true });
  const error = h("p", { class: "field-error", hidden: true });
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
  app.replaceChildren(h("div", { class: "auth" }, h("div", { class: "card" }, h("div", { class: "card-body" }, brand(), h("h1", {}, "Sign in"), form))));
  pw.focus();
}

// ── Shell ──────────────────────────────────────────────────────────────────

function renderShell() {
  const tab = currentTab();
  const nav = h(
    "nav",
    { class: "nav", "aria-label": "Sections" },
    TABS.map(([id, label]) => h("a", { href: `#/${id}`, "aria-current": id === tab ? "page" : null }, label))
  );
  app.replaceChildren(
    h("header", { class: "topbar" }, h("div", { class: "topbar-inner" }, brand(), nav)),
    h("main", { id: "main" })
  );
  renderMain();
}

function renderMain() {
  const main = document.getElementById("main");
  if (!main || !S.data) return;
  const views = { overview: viewOverview, connections: viewConnections, routing: viewRouting, keys: viewKeys, settings: viewSettings };
  main.replaceChildren(views[currentTab()]());
}

function pageHead(title, subtitle, ...actions) {
  return h("div", { class: "page-head" }, h("div", {}, h("h1", {}, title), subtitle && h("p", { class: "muted" }, subtitle)), actions.length ? h("div", { class: "row" }, actions) : null);
}

function notice(kind, ...content) {
  return h("div", { class: `notice ${kind}` }, h("span", { class: "icon", "aria-hidden": "true" }, kind === "ok" ? "✓" : "!"), h("div", {}, content));
}

function setupNotices() {
  const d = S.data;
  const out = [];
  if (!d.providers.length) out.push(notice("warn", "No connections yet. ", h("a", { href: "#/connections" }, "Add your first provider"), " so Claude Code has somewhere to go."));
  else if (!d.routes.default) out.push(notice("warn", "No default route. ", h("a", { href: "#/routing" }, "Pick a default connection and model"), "."));
  if (d.server.openMode) {
    out.push(notice("warn", "No client keys exist, so anything on this machine can use the gateway without a key. ", h("a", { href: "#/keys" }, "Create a client key"), " to require one."));
  } else if (!d.clientKeys.some((k) => !k.revokedAt)) {
    out.push(notice("danger", "No active client keys: every Claude Code request is being rejected. ", h("a", { href: "#/keys" }, "Create a client key"), "."));
  }
  return out;
}

// ── Overview ───────────────────────────────────────────────────────────────

function viewOverview() {
  const d = S.data;
  const t = d.stats;
  const stat = (label, value) => h("div", { class: "card stat" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value));
  const rows = S.activity.map((e) =>
    h(
      "tr",
      { class: e.status >= 400 || e.error ? "error" : null, title: e.error || null },
      h("td", { class: "nowrap mono" }, fmtTime(e.time)),
      h("td", { class: "nowrap" }, e.keyName || "—"),
      h("td", {}, h("div", {}, e.model || "—"), h("div", { class: "muted small" }, e.provider ? `→ ${e.provider} / ${e.upstreamModel}` : e.error || "")),
      h(
        "td",
        {},
        h("span", { class: `badge ${e.status >= 400 || e.error ? "danger" : "ok"}` }, e.error && e.status < 400 ? "aborted" : e.status),
        // The upstream refused these, so the gateway retried without them.
        e.droppedParams?.length
          ? h("div", { class: "muted small", title: `The provider rejected: ${e.droppedParams.join(", ")}` }, `−${e.droppedParams.join(", ")}`)
          : null
      ),
      h("td", { class: "nowrap hide-sm" }, e.stopReason || "—"),
      h("td", { class: "num" }, fmtNum(e.inputTokens)),
      h("td", { class: "num" }, fmtNum(e.outputTokens)),
      h("td", { class: "num hide-sm" }, fmtMs(e.ttftMs)),
      h("td", { class: "num" }, fmtMs(e.durationMs))
    )
  );
  return h(
    "div",
    { class: "stack" },
    pageHead("Overview", `Since the gateway started ${relTime(t.startedAt)}.`),
    setupNotices(),
    h("div", { class: "stats" }, stat("Requests", fmtNum(t.requests)), stat("Errors", fmtNum(t.errors)), stat("Input tokens", fmtNum(t.inputTokens)), stat("Output tokens", fmtNum(t.outputTokens))),
    h(
      "div",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Recent requests"), h("span", { class: "muted small" }, "Refreshes every 5 s")),
      rows.length
        ? h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              {},
              h(
                "thead",
                {},
                h("tr", {}, h("th", {}, "Time"), h("th", {}, "Key"), h("th", {}, "Model"), h("th", {}, "Status"), h("th", { class: "hide-sm" }, "Stop"), h("th", { class: "num" }, "In"), h("th", { class: "num" }, "Out"), h("th", { class: "num hide-sm" }, "First token"), h("th", { class: "num" }, "Total"))
              ),
              h("tbody", {}, rows)
            )
          )
        : h("div", { class: "empty" }, h("p", {}, "No requests yet. Point Claude Code at this gateway and they'll show up here."))
    )
  );
}

// ── Connections ────────────────────────────────────────────────────────────

function routesUsing(id) {
  const r = S.data.routes;
  const uses = [];
  if (r.default?.provider === id) uses.push("default");
  for (const [f] of FAMILIES) if (r[f]?.provider === id) uses.push(f);
  for (const m of r.models) if (m.provider === id) uses.push(m.displayName || m.id);
  for (const o of r.overrides) if (o.provider === id) uses.push(o.match);
  return uses;
}

function testResultView(result) {
  if (!result) return null;
  return h(
    "div",
    { class: "test-result" },
    h("span", { class: `dot ${result.ok ? "ok" : "danger"}` }),
    result.ok
      ? [h("strong", {}, "Connected"), h("span", { class: "muted" }, `${result.latencyMs} ms · ${result.models.length} model${result.models.length === 1 ? "" : "s"} available`)]
      : [h("strong", {}, "Failed"), h("span", { class: "muted" }, result.error)]
  );
}

/** A short description of how a connection sends its key. */
function authSchemeLabel(p) {
  if (p.authScheme === "x-api-key") return "x-api-key header";
  if (p.authScheme === "header") return `${p.authHeader || "api-key"} header`;
  if (p.authScheme === "none") return "no credential";
  return p.queryParams ? `Authorization: Bearer · ?${p.queryParams}` : "Authorization: Bearer";
}

function viewConnections() {
  const d = S.data;
  const add = h("button", { class: "primary", onclick: () => providerDialog() }, "Add connection");
  if (!d.providers.length) {
    return h(
      "div",
      { class: "stack" },
      pageHead("Connections", "OpenAI-compatible providers the gateway can send requests to."),
      h("div", { class: "card empty" }, h("h2", {}, "No connections yet"), h("p", {}, "Add a provider like OpenAI, Venice, DeepSeek or a local Ollama."), add)
    );
  }
  return h(
    "div",
    { class: "stack" },
    pageHead("Connections", "OpenAI-compatible providers the gateway can send requests to.", add),
    d.providers.map((p) => {
      const result = h("div");
      const uses = routesUsing(p.id);
      const test = h(
        "button",
        {
          class: "small",
          onclick: async () => {
            const r = await act(test, () => providerModels(p.id, true));
            result.replaceChildren(testResultView(r));
          }
        },
        "Test"
      );
      const del = h(
        "button",
        {
          class: "small danger",
          onclick: async () => {
            if (!(await confirmDialog({ title: `Delete ${p.name}?`, message: "The connection and its API key will be removed from the gateway.", confirmLabel: "Delete" }))) return;
            await act(del, () => api("DELETE", `/providers/${p.id}`));
            S.models.delete(p.id);
            await loadState();
            renderMain();
            toast(`Deleted ${p.name}`);
          }
        },
        "Delete"
      );
      return h(
        "div",
        { class: "card card-body provider" },
        h(
          "div",
          { class: "provider-top" },
          h("div", { class: "provider-title" }, h("div", { class: "row" }, h("h3", {}, p.name), uses.map((u) => h("span", { class: "badge accent" }, u))), h("div", { class: "mono" }, p.baseUrl)),
          h("div", { class: "row" }, test, h("button", { class: "small", onclick: () => providerDialog(p) }, "Edit"), del)
        ),
        h(
          "dl",
          { class: "meta" },
          h("div", {}, h("dt", {}, "API key"), h("dd", {}, p.apiKeyMasked)),
          h("div", {}, h("dt", {}, "Max output tokens"), h("dd", {}, p.maxOutputTokens ?? "no limit")),
          h("div", {}, h("dt", {}, "Reasoning models"), h("dd", {}, p.reasoningPattern || "built-in detection")),
          h("div", {}, h("dt", {}, "Auth"), h("dd", {}, authSchemeLabel(p))),
          h("div", {}, h("dt", {}, "Added"), h("dd", {}, fmtDate(p.createdAt)))
        ),
        result
      );
    })
  );
}

function providerDialog(existing) {  const isEdit = Boolean(existing);
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
  const pattern = h("input", { class: "mono", value: existing?.reasoningPattern ?? "", placeholder: "(^|/)(o\\d+(-|$)|gpt-5)|reasoner" });
  const authScheme = h(
    "select",
    { onchange: () => (authHeaderRow.hidden = authScheme.value !== "header") },
    AUTH_SCHEMES.map((s) => h("option", { value: s.value, selected: (existing?.authScheme ?? "bearer") === s.value }, s.label))
  );
  const authHeader = h("input", { class: "mono", value: existing?.authHeader ?? "", placeholder: "api-key" });
  const authHeaderRow = h(
    "label",
    { hidden: (existing?.authScheme ?? "bearer") !== "header" },
    "Auth header name",
    h("span", { class: "hint" }, "Header the key is sent in. Azure OpenAI uses “api-key”."),
    authHeader
  );
  const queryParams = h("input", { class: "mono", value: existing?.queryParams ?? "", placeholder: "api-version=2024-10-21" });
  const parameterRetry = h("input", {
    type: "checkbox",
    checked: existing ? existing.parameterRetry !== false : true
  });
  const listId = `models-${Math.random().toString(36).slice(2)}`;
  const datalist = h("datalist", { id: listId });
  const defaultModel = h("input", { class: "mono", list: listId, placeholder: "e.g. gpt-4.1", required: needsDefault });
  const result = h("div");
  const error = h("p", { class: "field-error", hidden: true });

  const preset = !isEdit
    ? h(
        "select",
        {
          onchange: () => {
            const p = PRESETS[Number(preset.value)];
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
        h("option", { value: "" }, "Choose a provider…"),
        PRESETS.map((p, i) => h("option", { value: String(i) }, p.label))
      )
    : null;

  const test = h(
    "button",
    {
      type: "button",
      onclick: async () => {
        const r = await act(test, () =>
          api("POST", "/providers/test", {
            id: existing?.id,
            baseUrl: baseUrl.value,
            apiKey: apiKey.value,
            authScheme: authScheme.value,
            authHeader: authHeader.value,
            queryParams: queryParams.value
          })
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
          d.close();
          await loadState();
          renderMain();
          toast(isEdit ? `Saved ${saved.name}` : `Added ${saved.name}`);
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      }
    },
    preset && h("label", {}, "Provider", preset),
    h("div", { class: "form-grid" }, h("label", {}, "Name", name), h("label", {}, "API key", apiKey)),
    h("label", {}, "Base URL", h("span", { class: "hint" }, "The OpenAI-compatible endpoint, ending before /chat/completions."), baseUrl),
    needsDefault && h("label", {}, "Default model", h("span", { class: "hint" }, "All Claude Code requests go here until you set up routing. Test the connection to pick from a list."), defaultModel, datalist),
    h(
      "details",
      {
        class: "advanced",
        open: Boolean(
          existing &&
            (existing.maxOutputTokens ||
              existing.reasoningPattern ||
              existing.authScheme !== "bearer" ||
              existing.queryParams ||
              existing.parameterRetry === false)
        )
      },
      h("summary", {}, "Advanced"),
      h(
        "div",
        { class: "form" },
        h("label", {}, "Max output tokens", h("span", { class: "hint" }, "Caps Claude Code's large max_tokens to what this provider accepts (gpt-4o: 16384)."), maxTokens),
        h("label", {}, "Reasoning models (regex)", h("span", { class: "hint" }, "Models matching this get max_completion_tokens and no temperature. Empty uses built-in detection."), pattern),
        h("label", {}, "Auth scheme", h("span", { class: "hint" }, "How the API key is sent. Most OpenAI-compatible providers use the default."), authScheme),
        authHeaderRow,
        h("label", {}, "Query parameters", h("span", { class: "hint" }, "Appended to every request URL, e.g. Azure's api-version. Leave empty for most providers."), queryParams),
        h(
          "label",
          { class: "checkbox" },
          parameterRetry,
          h("span", {}, "Retry without parameters the provider rejects (recommended)")
        )
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
  (preset || name).focus();
}

// ── Routing ────────────────────────────────────────────────────────────────

function providerSelect(value, { allowInherit = false, onchange, label } = {}) {
  return h(
    "select",
    { value: value ?? "", onchange, "aria-label": label },
    allowInherit ? h("option", { value: "" }, "Same as default") : h("option", { value: "", disabled: true }, "Choose…"),
    S.data.providers.map((p) => h("option", { value: p.id }, p.name))
  );
}

/** A connection select + model input whose suggestions follow the selected connection. */
function routeEditor(route, { allowInherit = false, label = "" } = {}) {
  const listId = `ml-${Math.random().toString(36).slice(2)}`;
  const datalist = h("datalist", { id: listId });
  const hint = h("div", { class: "muted small" });
  const model = h("input", { class: "mono", list: listId, value: route?.model ?? "", "aria-label": `${label} upstream model` });
  const refreshModels = async () => {
    model.disabled = allowInherit && !select.value;
    model.placeholder = model.disabled ? "Uses the default route" : "model name";
    if (model.disabled) {
      model.value = "";
      hint.textContent = "";
      return;
    }
    hint.textContent = "Loading models…";
    const r = await providerModels(select.value);
    datalist.replaceChildren(...r.models.map((m) => h("option", { value: m })));
    hint.textContent = r.ok ? `${r.models.length} models available` : r.error ? `Couldn't list models: ${r.error}` : "";
  };
  const select = providerSelect(route?.provider, { allowInherit, onchange: refreshModels, label: `${label} connection` });
  refreshModels();
  return {
    select,
    modelInput: model,
    modelCell: h("div", {}, model, datalist, hint),
    value: () => (select.value ? { provider: select.value, model: model.value.trim() } : null)
  };
}

function viewRouting() {
  const d = S.data;
  if (!d.providers.length) {
    return h("div", { class: "stack" }, pageHead("Routing", "Decide which connection and model serves each Claude model."), notice("warn", "Add a connection first. ", h("a", { href: "#/connections" }, "Go to Connections"), "."));
  }

  const def = routeEditor(d.routes.default, { label: "Default" });
  const families = FAMILIES.map(([id, label]) => ({ id, label, editor: routeEditor(d.routes[id], { allowInherit: true, label }) }));
  // ── Your models (listed in Claude Code's /model picker) ──
  const modelsEmpty = h("tr", {}, h("td", { colspan: "5", class: "muted" }, "None yet. Add one for each model you want to pick in Claude Code."));
  const modelsBody = h("tbody", {}, modelsEmpty);
  const customModels = [];
  const syncModelsEmpty = () => (modelsEmpty.hidden = customModels.length > 0);

  const addModel = (m) => {
    const editor = routeEditor(m, { label: "Model" });
    const name = h("input", { value: m?.displayName ?? "", placeholder: "Qwen Coder", "aria-label": "Name in the picker", maxlength: "80" });
    const id = h("input", { class: "mono", value: m?.id ?? "", placeholder: "claude-qwen-coder", "aria-label": "Model ID", maxlength: "100" });
    const warn = h("div", { class: "hint id-warn" });
    const suggest = h("button", { class: "small ghost", type: "button", hidden: true }, "Use suggested ID");
    // Fill name and ID from the upstream model until the user edits them.
    let autoName = !m;
    let autoId = !m;
    name.addEventListener("input", () => (autoName = false));
    id.addEventListener("input", () => (autoId = false));

    // Show, as you type, when Desktop would drop this ID.
    const checkId = () => {
      const value = id.value.trim();
      const problem = value ? checkModelId(value) : "ok";
      const upstream = editor.modelInput.value.trim();
      const suggested = upstream ? suggestModelId(upstream) : "";
      suggest.hidden = problem === "ok" || !suggested || suggested === value;
      if (problem === "vendor-name") {
        warn.textContent = `Claude Desktop drops IDs containing "${vendorToken(value)}" (Claude Code still shows it).`;
      } else if (problem === "no-claude") {
        warn.textContent = "Claude Code ignores IDs without “claude”, so it will not appear in /model.";
      } else if (problem === "charset") {
        warn.textContent = "IDs may only contain letters, digits and . _ : / -";
      } else if (problem === "too-long") {
        warn.textContent = "IDs are limited to 100 characters.";
      } else {
        warn.textContent = "";
      }
      warn.hidden = !warn.textContent;
      return problem;
    };
    id.addEventListener("input", checkId);
    suggest.addEventListener("click", () => {
      id.value = suggestModelId(editor.modelInput.value.trim());
      autoId = false;
      checkId();
      const upstream = editor.modelInput.value.trim();
      if (autoName && upstream) name.value = upstream;
    });
    editor.modelInput.addEventListener("input", () => {
      const upstream = editor.modelInput.value.trim();
      if (autoName) name.value = upstream;
      if (autoId) id.value = upstream ? suggestModelId(upstream) || `claude-${slug(upstream)}` : "";
      checkId();
    });
    const row = h(
      "tr",
      {},
      h("td", {}, name),
      h("td", {}, h("div", { class: "cell-id" }, id, suggest), warn),
      h("td", {}, editor.select),
      h("td", {}, editor.modelCell),
      h(
        "td",
        {},
        h(
          "button",
          {
            class: "small ghost",
            "aria-label": "Remove model",
            onclick: () => {
              customModels.splice(customModels.indexOf(entry), 1);
              row.remove();
              syncModelsEmpty();
            }
          },
          "Remove"
        )
      )
    );
    const entry = { name, id, editor };
    customModels.push(entry);
    modelsBody.append(row);
    syncModelsEmpty();
    // Existing rows get checked too, so a saved ID Desktop rejects is visible.
    checkId();
    if (!m) editor.select.focus();
  };
  d.routes.models.forEach(addModel);

  const emptyRow = h("tr", {}, h("td", { colspan: "4", class: "muted" }, "No overrides. Family routes handle everything."));
  const overridesBody = h("tbody", {}, emptyRow);
  const overrides = [];
  const syncEmpty = () => (emptyRow.hidden = overrides.length > 0);

  const addOverride = (o) => {
    const match = h("input", { class: "mono", value: o?.match ?? "", placeholder: "claude-sonnet-4-5", "aria-label": "Model name or prefix" });
    const editor = routeEditor(o, { label: "Override" });
    const row = h(
      "tr",
      {},
      h("td", {}, match),
      h("td", {}, editor.select),
      h("td", {}, editor.modelCell),
      h(
        "td",
        {},
        h(
          "button",
          {
            class: "small ghost",
            "aria-label": "Remove override",
            onclick: () => {
              overrides.splice(overrides.indexOf(entry), 1);
              row.remove();
              syncEmpty();
            }
          },
          "Remove"
        )
      )
    );
    const entry = { match, editor };
    overrides.push(entry);
    overridesBody.append(row);
    syncEmpty();
    if (!o) match.focus();
  };
  d.routes.overrides.forEach(addOverride);

  const save = h(
    "button",
    {
      class: "primary",
      onclick: async () => {
        const body = {
          default: def.value(),
          ...Object.fromEntries(families.map((f) => [f.id, f.editor.value()])),
          models: customModels.map((m) => ({ ...m.editor.value(), id: m.id.value.trim(), displayName: m.name.value.trim() })),
          overrides: overrides.map((o) => ({ match: o.match.value.trim(), ...o.editor.value() }))
        };
        await act(save, () => api("PUT", "/routes", body));
        await loadState();
        renderMain();
        toast("Routes saved — new requests use them immediately");
      }
    },
    "Save routes"
  );

  const tryInput = h("input", { class: "mono", placeholder: "claude-haiku-4-5-20251001", "aria-label": "Model name to test" });
  const tryResult = h("div", { class: "test-result" });
  const tryBtn = h(
    "button",
    {
      type: "submit",
      onclick: async (e) => {
        e.preventDefault();
        const r = await act(tryBtn, () => api("GET", `/resolve?model=${encodeURIComponent(tryInput.value.trim())}`));
        tryResult.replaceChildren(
          ...(r
            ? [h("span", { class: "dot ok" }), h("strong", {}, `${r.provider} / ${r.model}`), h("span", { class: "muted" }, `via ${r.rule}`)]
            : [h("span", { class: "dot danger" }), h("span", {}, "No route — requests for this model would fail")])
        );
      }
    },
    "Check"
  );

  return h(
    "div",
    { class: "stack" },
    pageHead("Routing", "Claude Code asks for Claude models by name; these rules decide where each request actually goes.", save),
    h(
      "div",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Model families"), h("span", { class: "muted small hide-sm" }, "Claude Code's built-in choices, any version")),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "route-table" },
          h("thead", {}, h("tr", {}, h("th", {}, "Claude model"), h("th", {}, "Connection"), h("th", {}, "Upstream model"))),
          h(
            "tbody",
            {},
            h("tr", {}, h("td", {}, "Default", h("div", { class: "muted small" }, "Everything else")), h("td", {}, def.select), h("td", {}, def.modelCell)),
            families.map((f) => h("tr", {}, h("td", {}, f.label), h("td", {}, f.editor.select), h("td", {}, f.editor.modelCell)))
          )
        )
      )
    ),
    h(
      "div",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Your models"), h("button", { class: "small", onclick: () => addModel() }, "Add model")),
      h(
        "div",
        { class: "card-body muted small" },
        "Extra entries for Claude Code's /model picker, as many as you like. Claude Code loads this list at startup when ",
        h("code", {}, "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1"),
        " is set (included in the snippet when you create a client key). IDs must contain \"claude\"; restart Claude Code after changes."
      ),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "route-table models" },
          h("thead", {}, h("tr", {}, h("th", {}, "Name in picker"), h("th", {}, "Model ID"), h("th", {}, "Connection"), h("th", {}, "Upstream model"), h("th", {}))),
          modelsBody
        )
      )
    ),
    h(
      "div",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Overrides"), h("button", { class: "small", onclick: () => addOverride() }, "Add override")),
      h("div", { class: "card-body muted small" }, "Checked after your models. Matches the exact model name, or any name starting with it (longest match wins). Non-Claude names like gpt-4.1 are passed to the default connection unchanged."),
      h("div", { class: "table-wrap" }, h("table", { class: "route-table" }, h("thead", {}, h("tr", {}, h("th", {}, "Model name or prefix"), h("th", {}, "Connection"), h("th", {}, "Upstream model"), h("th", {}))), overridesBody))
    ),
    h(
      "div",
      { class: "card card-body stack" },
      h("h2", {}, "Test a model name"),
      h("form", { class: "row" }, h("div", { class: "spacer" }, tryInput), tryBtn),
      tryResult,
      h("p", { class: "muted small" }, "Uses the saved routes.")
    )
  );
}

// ── Client keys ────────────────────────────────────────────────────────────

function connectSnippet(secret) {
  return `export ANTHROPIC_BASE_URL=${location.origin}\nexport ANTHROPIC_API_KEY=${secret}\nexport CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1\nclaude`;
}

function createKeyDialog() {
  const name = h("input", { placeholder: "e.g. macbook, work-laptop", required: true, maxlength: "60" });
  const error = h("p", { class: "field-error", hidden: true });
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
          await loadState();
          renderMain();
          showSecretDialog(key.name, secret);
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      }
    },
    h("label", {}, "Name", h("span", { class: "hint" }, "Which device or tool will use it. Each key tracks its own usage and can be revoked on its own."), name),
    error
  );
  const d = openDialog({ title: "Create client key", body: form, actions: [h("button", { type: "button", onclick: () => d.close() }, "Cancel"), create] });
  name.focus();
}

function showSecretDialog(name, secret) {
  const copyKey = h("button", { class: "small", onclick: () => copy(secret, copyKey) }, "Copy");
  const snippet = connectSnippet(secret);
  const copySnippet = h("button", { class: "small", onclick: () => copy(snippet, copySnippet) }, "Copy");
  const d = openDialog({
    title: `Key for ${name}`,
    body: [
      notice("warn", "Copy this key now. It's stored only as a hash and can't be shown again."),
      h("div", { class: "codeblock" }, secret, copyKey),
      h("p", { class: "muted small" }, "Use it from Claude Code on that device:"),
      h("div", { class: "codeblock" }, snippet, copySnippet)
    ],
    actions: [h("button", { class: "primary", onclick: () => d.close() }, "Done")]
  });
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
          if (!(await confirmDialog({ title: `Revoke ${k.name}?`, message: "Claude Code sessions using this key stop working immediately.", confirmLabel: "Revoke" }))) return;
          await act(revoke, () => api("POST", `/keys/${k.id}/revoke`));
          await loadState();
          renderMain();
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
          await loadState();
          renderMain();
        }
      },
      "Delete"
    );
    return h(
      "tr",
      { class: k.revokedAt ? "revoked" : null },
      h("td", {}, h("strong", {}, k.name)),
      h("td", { class: "mono nowrap" }, `${k.prefix}…`),
      h("td", { class: "nowrap hide-sm" }, fmtDate(k.createdAt)),
      h("td", { class: "nowrap" }, relTime(k.lastUsedAt)),
      h("td", { class: "num" }, fmtNum(k.usage.requests)),
      h("td", { class: "num hide-sm" }, `${fmtNum(k.usage.inputTokens)} / ${fmtNum(k.usage.outputTokens)}`),
      h("td", {}, k.revokedAt ? h("span", { class: "badge" }, "Revoked") : h("span", { class: "badge ok" }, "Active")),
      h("td", { class: "nowrap" }, h("div", { class: "row" }, k.revokedAt ? del : revoke))
    );
  });

  return h(
    "div",
    { class: "stack" },
    pageHead("Client keys", "Keys your devices use to reach this gateway (Claude Code's ANTHROPIC_API_KEY).", create),
    d.server.openMode && notice("warn", "No client keys yet, so anything on this machine can use the gateway without one. Once you create a key, every request needs a key."),
    keys.length
      ? h(
          "div",
          { class: "card" },
          h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              {},
              h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Key"), h("th", { class: "hide-sm" }, "Created"), h("th", {}, "Last used"), h("th", { class: "num" }, "Requests"), h("th", { class: "num hide-sm" }, "Tokens in / out"), h("th", {}, "Status"), h("th", {}))),
              h("tbody", {}, rows)
            )
          )
        )
      : h("div", { class: "card empty" }, h("h2", {}, "No client keys"), h("p", {}, "Create one key per device so you can see usage and revoke them separately."), create)
  );
}

// ── Settings ───────────────────────────────────────────────────────────────

function viewSettings() {
  const s = S.data.server;
  const current = h("input", { type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: "10", required: true });
  const error = h("p", { class: "field-error", hidden: true });
  const save = h("button", { class: "primary", type: "submit" }, "Change password");
  const form = h(
    "form",
    {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        try {
          await act(save, () => api("POST", "/password", { current: current.value, next: next.value }));
          current.value = next.value = "";
          toast("Password changed. Other sessions were signed out.");
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      }
    },
    usernameField(),
    h("div", { class: "form-grid" }, h("label", {}, "Current password", current), h("label", {}, "New password", h("span", { class: "hint" }, "At least 10 characters."), next)),
    error,
    h("div", {}, save)
  );
  const logout = h(
    "button",
    {
      onclick: async () => {
        await act(logout, () => api("POST", "/logout"));
        S.session = { authenticated: false, setupRequired: false };
        stopPolling();
        render();
      }
    },
    "Sign out"
  );
  const info = (label, value) => h("div", {}, h("dt", {}, label), h("dd", {}, value));
  return h(
    "div",
    { class: "stack" },
    pageHead("Settings", null, logout),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Admin password")), h("div", { class: "card-body" }, form)),
    h(
      "div",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Server")),
      h(
        "div",
        { class: "card-body" },
        h(
          "dl",
          { class: "meta" },
          info("Version", s.version),
          info("Listening on", `${s.host}:${s.port}`),
          info("Admin access", s.adminAllowFrom === "local" ? "Local networks & Tailscale only" : "Any address"),
          info("Data file", s.dataFile)
        ),
        h("p", { class: "muted small" }, "Server settings come from environment variables; see the README.")
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

async function boot() {
  try {
    S.session = await api("GET", "/session");
    if (S.session.authenticated) {
      await Promise.all([loadState(), loadActivity()]);
      startPolling();
    }
    render();
  } catch (err) {
    app.replaceChildren(h("div", { class: "auth" }, notice("danger", `Couldn't reach the gateway: ${err.message}`)));
  }
}

window.addEventListener("hashchange", () => {
  if (!S.session?.authenticated) return;
  renderShell();
  if (currentTab() === "overview") loadActivity().then(renderMain).catch(() => {});
});

boot();
