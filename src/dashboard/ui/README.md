# Easy DevOps dashboard UI

React rewrite of the dashboard, self-contained in `src/dashboard/ui/`. It talks
only to the REST and Socket.io API described in `docs/api-contract.md`, and is
temporarily built beside the old Vue/EJS UI until it is approved.

- React 19 · TypeScript 5.8 (strict) · Vite 6 · Tailwind 4 · react-router 7 · socket.io-client
- Dark theme by default (near-black surfaces, warm orange accent) with a full light theme
- All colours, type, radius, elevation and motion live in `src/design/tokens.css`

## Run it

Install once:

```bash
cd src/dashboard/ui
npm install
```

### Mock mode — no backend needed

```bash
npm run dev:mock      # http://localhost:5173
```

Every `/api` call and the socket are served in the browser from fixtures built
against the contract. Scenarios are selected with `?mock=`:

| URL | Shows |
| --- | --- |
| `/?mock=dashboard` | Normal dashboard with domains, certificates, PM2 processes |
| `/?mock=login` | Login screen (any non-empty password) |
| `/?mock=setup` | First run — set a password |
| `/?mock=setupcode` | First run with a setup code (code `123456`, mock-only) |
| `/?mock=setupcode-expired` | First run whose setup code has expired — shows how to get a new one |
| `/?mock=none` | No-password mode |
| `/?mock=service-stopped` | Background service stopped (not by the user) |
| `/?mock=service-stopped-by-you` | Personal-mode service stopped by the user (with a differing pinned Node) |
| `/?mock=service-not-installed` | Personal mode, service never installed |
| `/?mock=service-elevation` | Service running, but Start/Stop/Restart answer `403 elevation_required` |

Mock state is kept in `sessionStorage` under `ez-mock-state-v5:<scenario>`.
Reload the page after changing fixtures; destructive mock actions only change
that state. Service lifecycle actions in mock mode update the card in place and
emit `service:changed` on the mock socket, which is also replayed on connect.

Settings → Update runs a simulated update against this state: the phases
advance with the clock (about ten seconds in total), `/update/status` fails with
a connection error while the simulated dashboard is "restarting" so the
catching-up path is exercised, and the card ends on the result the detached
worker would have written.

### Dev server against the real dashboard

Start the dashboard the way you normally do so it listens on
`http://localhost:6443` (or set `EZ_DASHBOARD_ORIGIN` to its origin), then:

```bash
npm run dev           # http://localhost:5173
```

Vite proxies `/api` and `/socket.io` (HTTP polling then upgrade) to the
dashboard. The proxy rewrites `Origin`/`Host` so the dashboard's local-request
guard sees its own port; the backend check itself is not weakened. The API
client sends the session cookie and `X-EZ-Request: 1` on state-changing requests
and on the socket handshake, exactly as the contract requires. The socket is not
forced to websocket-only, because headers cannot be attached to an upgrade.

### Production build

```bash
npm run lint          # ESLint flat config (TypeScript + react-hooks)
npm run typecheck     # tsc --noEmit for app and vite config
npm run build         # writes ../../../dist/ui (repo-root dist/ui)
```

`base: './'` makes the bundle work under any mount path. The backend now serves
this build at `/` when the dashboard runs with `--new-ui` (or the
`dashboardUi: "new"` setting); see `UI_NEEDS.md` item 1. `npm run preview` only
serves the static shell; API calls need the dashboard behind the same origin.

### Bundle size (last build)

| Asset | Raw | Gzip |
| --- | --- | --- |
| `index-*.js` (app) | 503.13 kB | **145.17 kB** |
| `index-*.css` | 48.52 kB | 9.31 kB |
| `socket-*.js` (Socket.io client, lazy, on connect) | 42.07 kB | 13.20 kB |
| `socket-*.js` (mock adapter, lazy, mock builds only) | 17.28 kB | 5.80 kB |
| `index.html` | 2.61 kB | 1.03 kB |

Initial JS is ~145 kB gzipped, comfortably under the 300 kB budget. Both socket
chunks are lazy; a production build never fetches the mock adapter. No runtime
CDN requests; the only font is the system stack.

## Coverage versus the old UI

| Old UI (`src/dashboard/views`) | Feature | New UI | Notes |
| --- | --- | --- | --- |
| `login.ejs` | First run (password confirm, min length, no-password where allowed), login, 429/lockout messaging | `pages/AuthPage.tsx`, `app/AuthProvider.tsx` | Plus dormant setup-code field (mock-only, see UI_NEEDS) |
| `sidebar.ejs` | Navigation, brand, background-service state | `components/layout/Sidebar.tsx`, `Topbar.tsx`, `ServiceBanner.tsx` | Off-canvas nav below `lg`; banner says “Background service is running. This dashboard is the interface only.” and warns only when it is not |
| `overview.ejs` | Nginx state, domain health, certificate issues, quick actions | `pages/OverviewPage.tsx` | Live updates; each card links into the relevant page |
| `domains-panel.ejs` | Domain list, add, empty state | `pages/DomainsPage.tsx` | Search, status filters, health dots, per-domain badges |
| `domain-form.ejs` | Create/edit: name, port, backend, upstream type, www/wildcard, SSL, performance, security, advanced snippet; delete | `components/domains/DomainFormModal.tsx` | Inline validation; per-domain notification matrix (Discord/Telegram channels) |
| `ssl-panel.ejs` | Certificate list, issue (HTTP-01 and DNS-01 with TXT confirm/cancel), renew one/all | `pages/SslPage.tsx`, `components/ssl/*` | Expired certificates read “Nd overdue”; issue dialog verified read-only |
| `nginx-panel.ejs` | Start/stop/restart/reload/test, config list and editor with save + rollback, error log | `pages/NginxPage.tsx` | Live error **and** access logs via socket; refresh reloads status/configs and restarts the tail |
| `settings-panel.ejs` | Application config (port, ACME email, nginx/ssl dirs), background service, backup/restore, Linux permissions, notification channels, Hub pairing | `pages/SettingsPage.tsx` (General, Access, Hub, Backup), `components/settings/HubPanel.tsx`, `pages/NotificationsPage.tsx` | Channels moved to Notifications; permissions tree includes group checkboxes, partial state, coming-soon badges |
| `processes-panel.ejs` | Native background service state (mechanism, installed, PID, uptime, starts at logon/boot, stopped-by-you time, service vs system Node, warnings, install guidance), service Start/Stop/Restart, PM2 apps, PM2 modules, per-process logs | `pages/ProcessesPage.tsx` | Reads only `backgroundService`; service controls confirm first and render the exact elevation/install command with a copy button when the API cannot elevate; PM2 card lists only your own apps (`managed` apps such as `ez-dashboard` are filtered out), modules such as `pm2-logrotate` are grouped separately with a warning before stopping; CPU/memory report “—” when PM2 reports 0 |
| `logs-panel.ejs` | Live error log, clear | `pages/LogsPage.tsx` | Error and access tabs, pause with missed-line count, clear, reload tail |
| `public/js/app.js` | Toasts, confirmations, live updates, session handling | `app/RealtimeProvider.tsx`, `components/ui/Toast.tsx`, `ConfirmDialog.tsx`, `lib/api.ts` | 401 returns to login; 403 shows a “request blocked” banner |

New extras beyond the old UI: theme toggle, deep links (`?tab=`, `?file=`,
`?new=1`, `?domain=`), per-page error boundaries, layout-matching skeletons.

## Known gaps and deliberate limits

- **Access-log history:** the backend's `GET /api/nginx/logs` only returns the
  error log, so historical access lines do not exist. Both log views are fed by
  the live socket tail (server replays the last 50 lines on subscribe).
- **Notification history:** events are socket-delivered for the current session
  only; the contract has no history endpoint, and the old UI behaved the same.
- **Setup code expiry:** when `GET /api/auth` reports `setupCodeRequired` with
  `setupCodeExpiresAt: null`, the outstanding code is no longer usable (24 hours
  passed, or it was burned after 20 failed attempts). The first-run screen then
  says the code has expired and shows `ezz dashboard setup-code` instead of
  reporting the submission as simply invalid.
- **Two service shapes:** `GET /api/service` returns the full
  `backgroundService` (including `state`, `runtime` and `warnings`), but
  `service:changed` and lifecycle responses carry only the cheap live half. The
  UI overlays the socket snapshot on the last full read and schedules a
  coalesced re-fetch for the rich fields, plus a 15 s GET while the Processes
  page is open and on socket reconnect.
- **PM2 module flag:** the API has no “this is a module” field, so modules are
  recognised by their executable/cwd living under `<PM2_HOME>/modules/` (or a
  `pm2/modules` segment). That covers the normal `pm2 install` layout; a module
  started from an arbitrary path will appear under “Your PM2 apps”.
- **PM2 metrics:** PM2 can report `0` for CPU and memory it has not measured,
  which is common on Windows. The Processes page renders `—` for zero rather
  than claiming 0 B / 0%.
- **Screenshots:** none are committed. Visual checks were done in a live browser
  (dark/light, desktop and 375 px) rather than captured as files.
- Contract gaps found while verifying (all handled in the UI) are listed in
  `UI_NEEDS.md`.

## Manual QA checklist

Read-only rows can be run against the real dashboard; anything that changes nginx,
certificates, domains, processes or settings should be run in mock mode.

**Shell and session**
- [ ] First run accepts the terminal setup code with a new password (minimum 6 characters) and signs in.
- [ ] `?mock=setupcode-expired` shows “This code has expired. Get a new one with: ezz dashboard setup-code” instead of “not valid”.
- [ ] Login with a wrong password shows the server message; 429 shows the retry wait.
- [ ] After session expiry, any API call returns to login with a short explanation.
- [ ] A 403 shows the “request blocked” banner and does not sign you out.
- [ ] Theme toggle switches dark/light instantly and survives reload.
- [ ] Below `lg`, the hamburger opens the nav drawer; Escape closes it.
- [ ] Every page has a visible title, one `h1`, and works at 375 px with no horizontal scroll.

**Overview**
- [ ] Nginx state, domains, certificates and health counts match their pages.
- [ ] A dead live connection shows “Reconnecting…” and recovers without a reload.

**Domains**
- [ ] Search and status filters narrow the list; empty filters show a reset action.
- [ ] Opening a domain fills every field; Cancel discards; Save validates inline.
- [ ] Notification matrix: group toggle selects children, partial state is visible, coming-soon channels are disabled.
- [ ] Toggle/delete confirmations describe the real effect; list refreshes after each.

**SSL**
- [ ] Expiry badges and “overdue” text match the certificate list.
- [ ] Issue dialog: HTTP-01 path, DNS-01 TXT step, cancel leaves no pending state.
- [ ] Renew one/all show real per-domain results in a toast.

**Nginx**
- [ ] Start/stop/restart/reload/test each report the server output; confirmations precede disruption.
- [ ] Config editor loads, saves, and shows the rollback message when `nginx -t` fails.
- [ ] Error and access tabs stream lines, pause counts missed lines, Clear and Reload tail work.

**Notifications**
- [ ] Add/edit/delete a Discord and a Telegram channel; test message reports delivery.
- [ ] Empty channels state explains the next action; routing help matches the domain matrix.

**Processes**
- [ ] Background service card matches `backgroundService`: status, PID, uptime, mechanism, installed, starts at logon/boot, jobs owner, install command per platform.
- [ ] “Stopped by you” shows the local stop time (card, banner, Settings, Overview hint); Service Node and System Node versions are both shown, with same-as-system / pinned / re-pin notes.
- [ ] Start / Stop / Restart confirm first and update the card, banner, sidebar and Overview without a reload; a restart clears the stopped-by-you state.
- [ ] `?mock=service-elevation` shows the exact `sudo systemctl …` command with a Copy button instead of an error toast; `?mock=service-not-installed` shows the install command; starting an already-running service shows an info toast.
- [ ] Banner action “Open Processes” is hidden while the Processes page is open.
- [ ] Mock scenarios `service-stopped`, `service-stopped-by-you`, `service-not-installed` and `service-elevation` show the right banner and card copy.
- [ ] PM2 card lists only your own apps; the managed `ez-dashboard` entry never appears; `pm2-logrotate` appears under “PM2 modules” with a stop warning about unbounded logs.
- [ ] CPU and memory show `—`, not 0 B / 0%, when PM2 reports nothing.
- [ ] Process actions confirm first; failures show the contract error.
- [ ] Logs modal shows the process tail and handles an empty log.

**Settings**
- [ ] General: port/email/dirs validate inline; saving warns when a restart is needed.
- [ ] Access: bind address and auth mode restrictions are enforced; password fields never echo values.
- [ ] Linux permissions panel explains missing sudoers rules; setup failure shows the server message.
- [ ] Hub: unlinked state, connect validation, agent status, permission tree, unlink confirmation.
- [ ] Backup: download, restore confirmations, and the “never restores password/bind” note.

**Logs and motion**
- [ ] Error/access deep links (`#/logs?file=access`) work on reload.
- [ ] Toasts, drawers and modals animate 150–220 ms and respect `prefers-reduced-motion`.
- [ ] Focus is visible on every control; tab order follows the visual order.

## Verification status

On 2026-11-15 the UI was verified against the real dashboard at
`http://localhost:6443` with read-only actions only: page loads, `GET
/api/service`, the socket connection, and the PM2 list. The service card showed
the real explicit fields (Personal, starts at logon, service and system Node
`v22.21.1`), and the real `pm2-logrotate` module appeared under “PM2 modules”
with `—` metrics. **No Start, Stop or Restart was pressed against the real
service**, and no nginx, SSL, domain, process or settings action was triggered.

Mock mode additionally covered the first-run setup code: `?mock=setupcode`
rejected `000000` with “That setup code is not valid.” and accepted `123456`
with a seven-character password, signing in; `?mock=setupcode-expired` showed
“This code has expired. Get a new one with: ezz dashboard setup-code” on load
and did not report the rejected submission as “not valid”.

The real first-run flow was then verified on a fresh `.dev-data` with the
backend serving this build: the code printed by `node . --dash --dev` was
accepted together with a new password and signed in; a wrong code was rejected
with “That setup code is not valid.”; and the code is accepted with or without
the space.

Mock mode covered every state-changing flow: service Start / Stop / Restart
(including the `service:changed` update without a reload), the elevation and
not-installed command panels, the stopped-by-you timestamp and differing Node
versions, the module stop warning, and all four service scenarios.
