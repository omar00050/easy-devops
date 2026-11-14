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
| `/?mock=setupcode` | First run with a setup code (code `123456`, mock-only — see UI_NEEDS) |
| `/?mock=none` | No-password mode |
| `/?mock=service-stopped` | Background service stopped (not by the user) |
| `/?mock=service-stopped-by-you` | Personal-mode service stopped by the user |
| `/?mock=service-not-installed` | Personal mode, service never installed |

Mock state is kept in `sessionStorage` under `ez-mock-state-v3:<scenario>`.
Reload the page after changing fixtures; destructive mock actions only change
that state.

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
| `index-*.js` (app) | 494.99 kB | **142.85 kB** |
| `index-*.css` | 48.46 kB | 9.30 kB |
| `socket-*.js` (lazy, on connect) | 42.07 kB | 13.20 kB |
| `socket-*.js` (shared chunk) | 2.17 kB | 1.05 kB |
| `index.html` | 2.61 kB | 1.03 kB |

Initial JS is ~143 kB gzipped, comfortably under the 300 kB budget. The
Socket.io client is a lazy chunk, loaded only when live updates connect. No
runtime CDN requests; the only font is the system stack.

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
| `processes-panel.ejs` | Native background service state (mode, installed, PID, uptime, starts at logon/boot, Node runtime, install guidance), PM2 apps, per-process logs | `pages/ProcessesPage.tsx` | Background service card rebuilt on `backgroundService`; PM2 card lists only the user's own apps (`managed` apps such as `ez-dashboard` are filtered out); no service controls until lifecycle endpoints exist (UI_NEEDS #12) |
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
- **Setup code:** the first-run screen can ask for a setup code when the server
  reports `setupCodeRequired`, but the backend does not implement it. The field
  is unreachable against the real API and is only exercised by `?mock=setupcode`.
- **Background service fields:** the API still returns the PM2-era
  `installed`/`running`/`enabledOnBoot` fields, which report `false` while the
  native daemon runs. The UI reads `backgroundService` (daemon lock) instead and
  treats the explicit native fields (`mechanism`, `installed`, `startsAt`,
  `stoppedByUser`, `runtime`) as preferred when the backend adds them. Until
  then the mechanism is inferred from `bootMode` + `install`, “stopped by you”
  is always false, and the Node runtime is shown as not reported. Tracked in
  `UI_NEEDS.md` items 11–13.
- **Screenshots:** none are committed. Visual checks were done in a live browser
  (dark/light, desktop and 375 px) rather than captured as files.
- Contract gaps found while verifying (all handled in the UI) are listed in
  `UI_NEEDS.md`.

## Manual QA checklist

Read-only rows can be run against the real dashboard; anything that changes nginx,
certificates, domains, processes or settings should be run in mock mode.

**Shell and session**
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
- [ ] Background service card matches `backgroundService`: status, PID, uptime, mode, starts at logon/boot, install command per platform.
- [ ] Banner shows “Background service is running. This dashboard is the interface only.” only while the daemon runs; it warns when stopped or not installed.
- [ ] Mock scenarios `service-stopped`, `service-stopped-by-you` and `service-not-installed` show the right banner and card copy.
- [ ] PM2 card lists only your own apps; the managed `ez-dashboard` entry never appears.
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

On 2026-11-13 the UI was verified against the real dashboard at
`http://localhost:6443` with read-only actions only: login, every page load,
live status/log updates, and opening forms and dialogs without saving. No
nginx, SSL, domain, process, service or settings action was triggered. Mock mode
was used for every state-changing flow, including destructive confirmations.
