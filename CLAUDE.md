# Claude Gateway

Zero-dependency Node.js (>= 20.12) gateway: Claude Code speaks the Anthropic Messages API to it, and it
forwards to OpenAI-compatible providers via `/chat/completions`. Single-owner tool, reached over a
Tailscale tailnet. See README.md for user-facing behaviour.

## Commands

```bash
npm start            # run on HOST:PORT from .env (default 127.0.0.1:8080)
npm test             # node --test; fake upstreams, no network
npm run bench        # overhead vs. calling the upstream directly
docker compose up -d --build   # or docker-compose; publishes 127.0.0.1:5175
```

Run `npm test` after every change. There is no build step and no linter beyond `// @ts-check` JSDoc
(CI runs `tsc` over it), so keep types in JSDoc accurate.

## Layout

- `server.js` entry point; `src/server.js` HTTP routing, client auth, streaming, **fallbacks + cooldowns**
- `src/models.js` `resolveRoute()`: your models → overrides → non-Claude pass-through → families → default.
  Returns the route plus its resolved `fallbacks`.
- `src/upstream.js` one upstream call: timeouts, retries, parameter-rejection retry
- `src/store.js` persisted state in `data/gateway.json` (0600, atomic writes). `routeTargets()` lists
  every connection a route set uses, fallbacks included — use it for "is this connection in use".
- `src/admin/index.js` admin API (sessions, CSRF, Host and IP checks); `src/admin/public/` the UI
- `src/translate/` request / response / stream translation
- `test/helpers.js` `startStack()` / `fakeUpstream()` for HTTP tests

## Conventions

- **No dependencies.** Node built-ins only. Don't add packages.
- **Admin UI is vanilla JS** in one file (`app.js`). Build DOM with `h(tag, props, ...children)`,
  never from HTML strings (server data must not become markup).
- **The admin CSP forbids inline styles, inline scripts and web fonts.** Style with classes in
  `app.css` only; `style="…"` attributes silently do nothing.
- `[hidden]` is forced with `!important` in `app.css`, because component `display` rules would
  otherwise beat it.
- The admin server reads its static files **once at startup** (`STATIC` in `src/admin/index.js`):
  restart the gateway to see UI changes. A new public file needs a `STATIC` entry.
- Optional route fields are omitted when empty (`fallbacks` only exists when non-empty), so stored
  data and test fixtures stay stable.
- Client keys: verified by SHA-256 hash; the key itself is also kept (`secret`) so the UI can copy it,
  stripped from every API response except `GET /admin/api/keys/:id/secret`, and deleted on revoke.
- Docker: `HOST` is `0.0.0.0` in the container, so client keys are always required there.

## Gotchas

- Routing page: `viewRouting()` rebuilds from saved state on every render. Never re-render it while
  `S.dirty` is set; navigation away asks first (`hashchange` handler).
- Clipboard access needs a secure context; plain `http://` on a tailnet IP has none. `copy()` falls
  back to a dialog with the text selected — keep using it rather than calling the clipboard directly.
- Cooldowns and activity are in memory and reset on restart; `stats` say so in the UI.
