# Easy DevOps — Roadmap

**Start here next session.** 1.4.1 is prepared, not published, and waits for the user's real-server test. 1.4.0 was never published to npm, so 1.4.1 is the first release that will carry it. What remains is the real-server pass: run the manual tests in `docs-rev/fix-report-4.md` and `docs-rev/fix-report-5.md`, and verify the Windows Server service fixes in CHANGELOG `[1.4.1]`; on Linux, re-run the sudo permissions script after upgrading (CHANGELOG `[1.4.0]`, "Upgrading from 1.2/1.3"); then create the GitHub release `v1.4.1` and publish to npm with the manual `npm-publish.yml` workflow. Root CI cannot run until `ci.yml` is restored (Standing debt). After the release, start phase 1.5.0 with this prompt:

> Start phase 1.5.0 "Hub control and safety". First verify the 1.4.x patch item on a Linux server — `stopDashboard` may refuse the real dashboard pid — then write the PIN design (server-only set/change/unlock, hashed on the server, verified by the agent, bound to the exact command and payload).

Where the workspace stands and what comes next, in the order it should be done. Updated 2026-11-19 from the code, not from earlier plans. `docs_refactor/` is the audit of 2026-11-07 and is **out of date** — most of its security findings have since been fixed; use this file instead.

The workspace holds four projects. `hub_backend/`, `hub_frontend/` and `docs/` each have their own git repository and are kept here for development only.

| Project | What it is | State |
|---|---|---|
| root (`src/`) | The `easy-devops` npm package: CLI, local dashboard, daemon, Hub agent | `1.4.0` prepared in `package.json` and `CHANGELOG.md`; not yet published |
| `hub_backend/` | Hub API + agent socket (Express, Prisma, SQLite for now) | `0.2.1`; working, one account per user, no Teams yet |
| `hub_frontend/` | Hub web UI (Next.js) | `0.1.2`; working, one account per user; dashboard parity done, no Teams yet |
| `docs/` | Documentation and landing site (Next.js) | `1.1.0`; CI builds it; no ESLint config yet |

---

## Versioning policy

### 1.4.0 — everything in CHANGELOG `[1.4.0]`

- Remaining before release: the real-server tests (the manual plans in `docs-rev/fix-report-4.md` and `docs-rev/fix-report-5.md`), the first CI run after `ci.yml` is restored, the GitHub release `v1.4.0`, and `npm publish`.
- On Linux, re-run the sudo permissions script after upgrading. The grant is now exactly five fixed `systemctl … nginx` commands; the old rules were wider (CHANGELOG `[1.4.0]`, "Upgrading from 1.2/1.3").

### 1.4.x — bug fixes only

No new features, no breaking contract change.

1. [ ] **Possible real bug, verify first:** on Linux, `stopDashboard` may refuse the real dashboard pid (its command-line matcher fails in the security-hardening suite on ubuntu), which would break Settings > Update on Linux servers. Verify on a Linux server; fix if real.
2. [x] **Windows Server-mode service fixes now in 1.4.1:** WinSW name, backup path, Personal mode on Windows Server, sc.exe, status vs Windows, restart counting, install wait, repair while running, hub state in Server mode, real elevation check, troubleshooting page. (1.4.1, CHANGELOG `[1.4.1]`.)
3. [ ] Status shows a clean restart correctly on a real Windows Server — verified only after the user's real test of 1.4.1.
4. [ ] The six Linux e2e failures listed under Standing debt, when root CI is restored.
5. [ ] Verify `ezz update` on a real Windows machine (Personal and Server mode): the CLI runs from the npm folder it replaces and holds better_sqlite3.node open, so it may hit EBUSY; if it does, run the npm step from a detached process after the CLI exits, as the dashboard update worker does (`src/dashboard/updateWorker.js`).
6. [x] **Hub SSL issue/delete (1.4.2):** the server already granted `ssl.issue` and `ssl.delete`, but the Hub only offered renew. The Hub SSL page now issues (HTTP-01 only; DNS-01/wildcard stays server-only with the reason shown) and deletes (refused while in use, with the domains that use it), and the Hub domain form matches the dashboard's, including Create certificate. The agent's delete was also made traversal-safe. The PIN one-time run for these actions stays in 1.5.0. (CHANGELOG `[1.4.2]`, `docs-rev/progress-7.md`.)
7. [x] **Deployment run view parity (1.4.3):** the dashboard's app detail shows the real current stage and the same stage bar as the Hub (Fetch > Settings > Pre > Install > Build > Migrate > Start > Health > Post > Finish; done, current, failed, skipped), fed by the run record's new `stage` and `skippedStages`; one stage list per app, same names and order. The dashboard also gained the Hub's Environment tab. (CHANGELOG `[1.4.3]`, `docs-rev/progress-8.md`.)

### 1.5.0 — the next phase

The phase below ("1.5.0: Hub control and safety"). No feature work lands in 1.4.x.

### Release process (decision)

- `npm-publish.yml` is manual (`workflow_dispatch`). It runs the dashboard UI checks (typecheck, lint, build), builds the UI, checks the package contents (`dist/ui/index.html` present, no UI sources), and publishes with `--ignore-scripts`.
- The e2e suites are run locally (`npm test`) before publishing, until the Linux CI is fixed.
- Anything touching the service, installers or data migration is tested on a real Windows Server and a real Linux machine before publishing.

## Phase 1 — Housekeeping · DONE

- [x] README matches the product (React dashboard, proxy-mode HTTP-01, automatic renewal, first-run password/setup code). (`README.md`; CHANGELOG `[1.4.0]`.)
- [x] This roadmap replaces `docs_refactor/` as the status of record. (This file.)
- [x] Old working files (`docs-old/`, `phases/`, `docs_refactor/`, `memory.md`, autopilot scripts and logs, old `specs/`) are **kept as they are**, by decision. (All still present at the workspace root.)

## Phase 2 — Things that did not work as specified · DONE

- [x] Hub domain health is a real probe, not the `enabled` flag. (`src/core/jobs/monitors.js`; `src/core/hub/agent.js` `domain:health`; `hub_backend/src/lib/agentServer.ts` stores the real `healthStatus`.)
- [x] `Metric.nginxStatus` records the real nginx state. (`hub_backend/prisma/schema.prisma`; `hub_backend/src/lib/agentServer.ts`; `hub_backend/src/lib/metrics.ts`.)
- [x] `core/cert-operations.js` no longer imports from `cli/`. (No `cli/` import in that file.)
- [x] A renewal keeps the certificate's names (`www`) and reloads nginx. (`src/core/cert-renewal.js`; README "Automatic renewal".)

## Phase 3 — Automatic certificate renewal · DONE

- [x] The daemon renews HTTP-01 certificates 7 days before expiry. (`src/core/cert-renewal.js`, `DEFAULT_AUTO_RENEW_DAYS = 7`.)
- [x] Setting in dashboard and CLI: on by default, window 1–30 days. (`src/core/cert-renewal.js`; `src/cli/menus/settings.js`; `src/dashboard/controllers/settingsController.js`.)
- [x] DNS-01 / wildcard certificates: warning only, and the warning says so. (`src/core/cert-renewal.js`, `dns-01` branch; README.)
- [x] Notifications for "renewed" and "renewal failed". (`src/core/cert-renewal.js`, `report()`.)
- [x] `e2e/cert-renewal.test.mjs`. (File present.)

Not done, and worth deciding:

- [ ] Per-domain opt-out (`ssl.autoRenew: false`). The global switch exists; a per-domain one needs a field in the domain form and the validator.
- [ ] Run one real renewal against Let's Encrypt **staging** on a Linux and a Windows server. The decisions are tested; the ACME exchange itself cannot be in CI.

The old "DNS-provider APIs (Cloudflare first)" item moved to "DNS and notifications" below.

## Phase 4 — Deployments (CI/CD), stage 1 · DONE

The local half: everything works with no Hub at all.

- [x] `core/deploy/` — `ez.json` + package.json defaults (`ezfile.js`), the app registry (`apps.js`), the on-disk store and per-app lock (`store.js`), the engine (`engine.js`), the deploy hook (`hookServer.js`), the GitHub workflow generator (`github.js`). (All files present.)
- [x] Releases, PM2 as the runner, health check, automatic and manual rollback. (CHANGELOG `[1.4.0]`, "Deployments".)
- [x] Private repositories: per-app deploy key, or access token. (CHANGELOG `[1.4.0]`, "Deploy keys in one step".)
- [x] Per-app environment variables. (CHANGELOG `[1.4.0]`, "Deployments"; `src/core/deploy/engine.js`.)
- [x] Option A — GitHub Actions calls the deploy hook, exposed through a domain (nginx) or directly. (CHANGELOG `[1.4.0]`, "Deployments".)
- [x] Dashboard: the Deployments page, with the GitHub setup steps. (`src/dashboard/ui/src/pages/DeploymentsPage.tsx`; `AppSetupTabs.tsx`.)
- [x] Ordered deploy steps, runtime field, presets, drag reorder and the step switch. (CHANGELOG `[1.4.0]`, "Deployments: ordered steps, runtimes and presets"; `docs-rev/fix-report-5.md` §1–3.)
- [x] Contract 2.4.0 and `e2e/deploy.test.mjs`. (CHANGELOG `[1.4.0]`, "Deployments"; test file present. Current contract is 2.17.0.)

Decisions taken here that the constitution should record (CLAUDE.md "Hard rules"):

- **The daemon may open one port, opt-in:** the deploy hook. Off by default, loopback by default, only `/.ez-deploy/`, per-app token. Every dashboard `/api` route is still behind the session gate — rule 11 is unchanged.
- **`core/shell.js` has a second entry point,** `runCommandLine()`, for commands a user wrote. It is still the only module that spawns.
- **Deployment state is files, not database rows** (runs, logs, lock, live-release pointer), because two processes write it and `good.db` has no compare-and-swap. The app registry stays in the database.

Not done in stage 1:

- [ ] **Verify on real machines.** The pipeline is tested end to end on Linux with a stand-in for PM2. Not yet run against a real PM2, on Windows (PowerShell quoting of the git commands, OpenSSH's permission check on a deploy key under `ProgramData`), or through a real nginx location.
- [ ] Zero-downtime for fork mode. Cluster mode now reloads instead of restarting (CHANGELOG `[1.4.0]`, "Cluster mode"); a fork app still stops before the new one starts. (`src/core/deploy/engine.js` says this explicitly.)
- [ ] Static sites served by nginx straight from a release (no process). (CHANGELOG `[1.4.0]` says it is still not offered.)
- [ ] A CLI: `ezz deploy <app>`, `ezz deploy list`. The engine is in core, so this is a thin menu. (No deploy command in `src/cli/`.)
- [ ] Deployment events on the notification settings page (today each app picks its channels in its own form). (`src/dashboard/ui/src/pages/NotificationsPage.tsx` has no deployment event.)

## Phase 5 — Deployments, stage 2: the Hub · DONE

- [x] Agent telemetry `deploy:apps` — the public view: no environment values, no credentials. (`src/core/hub/agent.js`; CHANGELOG `[1.4.0]`.)
- [x] `hub:manageDeploy`, gated per action by six permissions (`deploy.run`, `.rollback`, `.logs`, `.manage`, `.env`, `.ci`), all off by default. (`src/core/hubPermissions.js`; `hub_backend/src/Types/index.ts`.)
- [x] Option B: `POST /api/v1/hooks/deploy/<serverId>/<app>` on the Hub, relayed over the agent socket. The app's own token, verified by the server; the Hub stores nothing. (`hub_backend/src/routes/api/v1/hooks.ts`; `hooks.test.ts`.)
- [x] Hub UI: a Deployments section on the server page. (`hub_frontend/src/components/servers/DeploySection.tsx`.)
- [x] Automatic GitHub setup (secrets, workflow file, deploy key), next to the manual steps. Adds `tweetnacl` and `blakejs` — an explicit decision (rule 7). (`src/core/deploy/githubApi.js`; `src/dashboard/controllers/deploymentsController.js`; `package.json`.)
- [x] Contract 2.5.0; tests in `e2e/deploy.test.mjs` and `hub_backend` (`src/routes/api/v1/hooks.test.ts`). (Both files present.)
- [x] Deploy keys in one step. (CHANGELOG `[1.4.0]`, "Deploy keys in one step"; `docs-rev/fix-report-3.md`.)
- [x] Live deployment progress through the Hub. (CHANGELOG `[1.4.0]`, "Live deployment progress through the Hub"; `src/core/hub/deployProgress.js`.)
- [x] Link a domain with SSL, with live stages. (CHANGELOG `[1.4.0]`, "Link a domain with SSL"; `docs-rev/fix-report-3.md`; `src/core/deploy/domainLink.js`.)

Not done:

- [ ] **Run it for real.** Tested with a stand-in for PM2 and a stand-in for api.github.com. Still to do against a real PM2, a real repository, a real Hub, and on Windows.
- [ ] The Hub does not persist the app list; it shows what the agent last pushed. Teams will need it stored (below).
- [ ] Automatic GitHub setup from the Hub (today it is in the server's own dashboard only). (`hub_frontend` GitHub tab shows setup steps; no "apply for me" action.)
- [ ] Everything listed as not done under stage 1 (zero-downtime for fork mode, static sites, a CLI).

## Phase 5b — Domains, folders and guidance for deployments · DONE

- [x] Link an app to a domain (new or existing), optional certificate, and the domain follows the app's port. (`src/core/deploy/domainLink.js`; CHANGELOG `[1.4.0]`.)
- [x] Deleting an app asks what to do with its domain. (`src/core/deploy/hubCommands.js`, `deleteDomain`; `src/dashboard/controllers/deploymentsController.js`.)
- [x] `deployDir` setting (`ez_deploys`); every app keeps the folder it was created in. (`src/core/deploy/store.js`.)
- [x] Move an app: stop in PM2 → move → start again. (`src/core/deploy/hubCommands.js`, `case 'move'`; `hub_frontend/src/components/servers/deploy/AppDetailModal.tsx`.)
- [x] ez.json guide tab and a "how it works" for the GitHub flow. (`src/dashboard/ui/src/components/deployments/AppSetupTabs.tsx`.)
- [x] The same actions from the Hub. (`hub_frontend/src/components/servers/deploy/`; `src/core/deploy/hubCommands.js`.)

## Phase 5c — The rest of the 1.4.0 cycle · DONE (except as noted)

Deployments and SSL:

- [x] Zero-downtime switching in cluster mode only: `pm2 reload` overlaps workers. (`src/core/deploy/engine.js`; CHANGELOG `[1.4.0]`, "Cluster mode".)
- [x] SSL preflight and live stages: DNS, IPv6, HTTP path and Cloudflare checked before ACME; nine stages in dashboard, CLI and Hub. (`src/core/ssl/preflight.js`, `src/core/ssl/progress.js`; CHANGELOG `[1.4.0]`, "SSL: a preflight, live stages and an honest certificate list"; `e2e/ssl-preflight.test.mjs`.)
- [x] GitHub secrets and the workflow committed through GitHub's API. (`src/core/deploy/githubApi.js`; `src/dashboard/controllers/deploymentsController.js`, `githubApply`; `tweetnacl`/`blakejs` in `package.json`.)

Hub and UI:

- [x] Server-side metric bucketing and a real `range=all`. (`hub_backend/src/lib/metrics.ts`, `bucketSecondsFor`/`resolveMetricsWindow`; `hub_backend/src/controllers/servers.controller.ts`; `HUB_UI_NEEDS.md` §2.)
- [x] Password reset. (`hub_backend/src/Service/auth.ts`; `hub_backend/src/routes/api/v1/auth.ts`, `/forgot-password` and `/reset-password`; `hub_frontend/src/app/forgot-password` and `reset-password`.)
- [x] Hub parity with the dashboard: same sections, order, names and icons. (CHANGELOG `[1.4.0]`, "The Hub's server page is the dashboard's"; `docs-rev/fix-report-3.md`; audit in `docs-rev/ux-parity.md`.)
- [x] One channel picker in every form, with type badges and permission-disabled channels in the Hub. (CHANGELOG `[1.4.0]`, "Notifications: one channel picker in every form"; `docs-rev/fix-report-5.md` §4.)
- [x] `src/dashboard/ui/UI_NEEDS.md` has no open item: #1, #5, #9, #11–#13 are marked done, and #2, #3, #4, #6–#8, #10 are now pinned in `API-CONTRACT.md` (process logs §2.7, nginx logs §2.4, `sslPathWarning` §2.3, log replay §3.2).
- [x] `hub_frontend/HUB_UI_NEEDS.md`: items 1, 2 and 4–12 are Done. Item 3 (httpOnly cookie) stays open under "Before the Hub is public".
- [x] `docs-ui/` exists as local, gitignored agent knowledge, and every UI brief reads and updates it. (`docs-ui/README.md`; `.gitignore`; `AGENTS.md` in the root and `hub_frontend`; CLAUDE.md rule 30.)
- [ ] Record each channel's last test result. Today neither the dashboard API nor the agent reports it; the picker shows a badge only in mock data. (`docs-rev/fix-report-5.md`, "Open issues".)

CLI and release hygiene:

- [x] Pair with the Hub from the CLI: `ezz hub connect <link>`, `status` and `unlink`, one-time 5-minute link. (CHANGELOG `[1.4.0]`, "Pairing from the terminal"; `src/core/hubConnect.js`; `e2e/hub-connect-cli.test.mjs`.)
- [x] Clean CLI pages: breadcrumb, one Back/Exit, no escape bytes in a pipe or CI. (`src/cli/ui/page.js`; CHANGELOG `[1.4.0]`, "Clean CLI pages"; `e2e/cli-pages.test.mjs`.)
- [x] CHANGELOG cut to `[Unreleased]` (empty) and `[1.4.0] — 2026-11-19`. (CHANGELOG; `docs-rev/fix-report-4.md`, "Wave 3".)
- [x] The daemon test flake is fixed: the payload assertion matches its own `pid` instead of the first `nginx:status`. (`e2e/daemon.test.mjs`, lines 593–607.)
- [x] CI checks exist for `docs`, `hub_backend` and `hub_frontend`: docs build (`docs/.github/workflows/ci.yml`); backend typecheck, vitest and build (`hub_backend/.github/workflows/ez-deploy-ez-hub-backend.yml`); frontend lint, typecheck and build (`hub_frontend/.github/workflows/ez-deploy-ez-hub-frontend.yml`).
- [ ] Root CI is **not** done. `.github/workflows/ci.yml` is present locally but removed from git for now; its first ubuntu run failed six suites (Standing debt).

## Phase 1.5.0 — Hub control and safety · NEXT

### Security audit follow-up

- [ ] EZ-09 — Keep rotated secrets out of historical deployment logs served to readers.
- [ ] EZ-10 — Verify the Windows Node installer before running it and reject stale downloads.
- [ ] EZ-11 — Restrict Linux permission setup to directories managed by Easy DevOps.
- [ ] EZ-12 — Limit certificate purge to managed certificate files.
- [ ] EZ-13 — Pin and verify scripts used by the Linux installer.
- [ ] EZ-14 — Require encrypted transport for remote dashboard access and Hub pairing.
- [ ] EZ-16 — Bound memory use when reading logs and collecting build output.
- [ ] EZ-17 — Count concurrent failed setup-code attempts atomically.
- [ ] EZ-18 — Enforce the Hub pairing response size limit while reading the response.
- [ ] EZ-19 — Send only the domain fields needed for routine Hub monitoring.
- [ ] EZ-20 — Require `deploy.logs` before including crash logs in monitoring responses.

### PIN (two functions)

- (a) Changing the permission tree from the Hub requires the PIN.
- (b) A command whose permission is off is not just disabled in the Hub: clicking it asks for the PIN and runs that one command once, while the permission stays off.
- Ordinary commands (restart, stop, deploy, delete) never ask for the PIN; they keep the normal confirmation.
- The PIN is set, changed and unlocked only on the server (dashboard or CLI), stored hashed on the server, verified by the agent, never stored by the Hub. It is bound to the exact command and payload it was entered for. At least 6 digits.
- Dashboard settings: attempt limit and lockout duration (configurable within safe bounds, for example 3–10 attempts), and "allow running disabled commands once with the PIN" on/off.
- One attempt counter for both functions.
- Every PIN use is logged on the server, with an optional notification.

### Hub screens now "managed on the server" become real

- ~~SSL issue and delete~~ — done in 1.4.2 (see 1.4.x item 6). What stays here: running them once with the PIN while `ssl.issue` / `ssl.delete` is off (PIN function b).
- Notification channels: add, edit, delete, test. Secrets are write-only — never stored or shown by the Hub, masked in the display, and "enter a new value" to change them.
- Server settings, except the most sensitive ones such as the dashboard password and bind address.
- Access log and PM2 logs: read-only, with secrets hidden.
- Service start/stop/restart. Warn that stopping the service disconnects the Hub.

### New permissions, off by default

Agreed in both permission maps with a test: `notifications.view`, `notifications.manage`, `settings.view`, `settings.manage`, `logs.access.view`, `process.logs.view`, `service.manage`, `doctor.run`.

### `ezz doctor`

A read-only health check: nginx and its config, ports 80/443, DNS of every domain against this server, certificates near expiry, sudo rules, the service, the Node runtime, disk space, the Hub link. Each problem comes with a fix. Also a "Health check" button in the dashboard and in the Hub.

### Remaining gaps closed in this phase

- The dashboard app form shows the steps resolved from `ez.json` (today it shows only the app's overrides; `docs-rev/fix-report-4.md`, "Open issues"; CHANGELOG `[1.4.0]` says it shows an inherit panel instead).
- The Hub's per-channel selection uses the new notifications permissions instead of `domains.edit`.
- Record each notification channel's last test result (passed/failed and when), so the channel picker's test badge shows on real channels in the dashboard and the Hub (today the API never reports it; `docs-rev/fix-report-5.md`).

## 1.6.0: Supply-chain security (dependency checks before install)

Agreed design (2026-11-20):
- Source: OSV.dev, called directly (no proxy through the Hub). Works with or without a Hub link.
  The advisory source is pluggable, so the Hub can be added later as an extra source (our own blocklist).
- When: after the code is fetched and BEFORE the install step, because malicious packages run at install time
  (postinstall scripts).
- What is checked: the lockfile (package-lock.json, yarn.lock, pnpm-lock.yaml; later requirements.txt/poetry.lock and
  the other ecosystems OSV covers), including transitive dependencies. With no lockfile: check the direct
  dependencies only and say the check is partial.
- Batched queries, results cached by lockfile hash, so a deploy is not slowed down.
- Severity and default policy:
  - malicious package: stop the deploy by default; continuing needs an explicit confirmation (and the PIN once it
    exists), with an option to install with --ignore-scripts;
  - critical / high: warn and ask before continuing;
  - medium / low: information only.
  - CI / webhook deploys (nobody to confirm): stop on malicious, warn and notify otherwise. Policy per app.
- Each finding shows: package, version, advisory id (GHSA/CVE), severity, fixed version, link.
- On by default, can be turned off globally and per app (privacy: package names and versions are sent to OSV.dev;
  stated clearly in Settings and the docs). One-time notice after upgrading.
- OSV unreachable or no internet: no error, a short note ("dependency check unavailable"), the deploy continues;
  the last downloaded advisories are kept locally and used as a fallback.
- Daily job in the daemon re-checks the live release of every app; new findings send a notification and show a badge
  on the app in the dashboard and the Hub.
- Allowlist per app: ignore a finding with a reason and an expiry date.
- Same view in the dashboard, the Hub and the deploy log.

## Later phases (in this order)

### Server security

- Run deployed apps as a normal user instead of root.
- Firewall helper: show open ports and the process behind each, close what is not needed, a Cloudflare-only option, and never lock out SSH. Every change applies with an auto-revert timer unless confirmed. Account for Docker publishing ports past `ufw`.

### DNS and notifications

- Cloudflare integration with an API token: create DNS records, handle the HTTPS exception during issuance, and renew wildcards unattended through DNS-01. This merges the old "DNS-provider APIs (Cloudflare first)" item from Phase 3.
- Hub notifications: server down/up, deploy failed, certificate expiring, disk almost full.

### Phase 6 — Hub Teams (after the per-server action log)

Hub only. The server-side package never learns about teams; its own permission tree stays the real gate and the Hub can only narrow it.

Agreed:

- Anyone can create an account. An account **owns its servers** and adds the people it wants.
- Roles: **Owner**, **Admin**, **Member**, **Viewer**.
- Members are added by email and must already have a Hub account. No invitation emails.
- **The Owner sets what each person may do, permission by permission** — the same list the server shows (nginx, domains, SSL, deployments…), narrowed per person.
- **Per-app access:** a person can be added to specific apps, with specific actions on each — and whether they may **create** an app at all (connect a repository and deploy it).
- **Admin** may add and change secrets (environment variables, tokens). **Member** may not delete anything; a Member is limited to the light operations the Owner allows, such as start, stop and deploy.
- The model to follow is Coolify's: a team owns resources, members hold a role, and access can be narrowed per resource.

**Agreed** (2026-11-15):

| | Viewer | Member | Admin | Owner |
|---|---|---|---|---|
| See servers, apps, status | ✓ | ✓ | ✓ | ✓ |
| Deploy, roll back, start/stop | — | if granted | ✓ | ✓ |
| Read deployment logs | if granted | if granted | ✓ | ✓ |
| Create / edit apps | — | if granted | ✓ | ✓ |
| Environment variables, deploy tokens | — | — | ✓ | ✓ |
| Delete an app, a domain, a certificate | — | — | ✓ | ✓ |
| Add and remove people, set their permissions | — | — | — | ✓ |
| Remove a server, rotate its secret | — | — | — | ✓ |

Why it was not built together with the deployment work: a restricted Member must not *receive* what
they may not see. Today the Hub relays a server's live events — nginx configs, logs, the full app list —
to one room that every subscriber of that server joins. Adding roles to the REST checks alone would
produce a Hub that refuses a Member's command while still streaming them every app and every log. The
relay has to be filtered per viewer first, and that is the larger half of the work.

Still to settle:

1. When a new app is created, who can act on it by default — everyone who could deploy before, or only its creator and the Admins? (Proposed: creator + Admins + Owner.)
2. Build on SQLite now and migrate, or move to PostgreSQL first?
3. More than one Owner per server? And what happens to a server when its Owner's account is deleted?

Prerequisites this phase forces, in order:

- [ ] **First: the per-server action log** — who did what, from the dashboard, the Hub or the CLI.
- [ ] Persist the app list per server in the Hub (it is relayed and forgotten today), so permissions have something to attach to while a server is offline.
- [ ] Split `Server.permissions` — it also carries `_platform`, `_sslDir` and `_channels`, and one writer can clobber another.
- [ ] Every REST handler, the browser socket's `subscribe:server` and `dispatchCommand` check ownership by `userId` today. They move to "is a member with this permission on this app".
- [ ] The `deploy:apps` relay must be filtered per viewer once per-app access exists — today everyone subscribed to a server sees all of its apps.
- [ ] PostgreSQL before this ships to more than one Hub instance (already planned).

### Runtimes and data

- Python runtime.
- Docker runtime, with the same steps and UX as the runtime cards.
- PostgreSQL management.
- Self-update by the service (download, verify, swap, restart, roll back), which also enables updating from the Hub; needs its own design for who may trigger it.

### Junior mode

- A guided side panel explaining each live step: what, why, and what can go wrong.
- "What will change" before actions.
- A glossary with "?" tooltips.
- A first-run checklist.
- English and Arabic.
- Dashboard first, then the Hub.
- Progress stages need stable machine-readable ids.

## Phase 7 — Before the Hub is public

Only what is still open:

- [ ] PostgreSQL instead of SQLite. `hub_backend/prisma/schema.prisma` still says `provider = "sqlite"`, and SQLite's single-writer lock rules out more than one Hub instance (`hub_backend/ARCHITECTURE.md`).
- [ ] Session in an httpOnly cookie instead of `localStorage`. Still open: no `Set-Cookie` on login/register, no session cookie accepted by the API, no `hub_frontend` middleware (`HUB_UI_NEEDS.md` §3).
- [ ] Email verification for local accounts, if not done. `hub_backend` has no verification token or `emailVerified` field for password signups; only OAuth identities set `emailVerified: true` (`hub_backend/src/lib/oauth.ts`).
- [ ] Dockerfile / deploy recipe for `hub_backend` and `hub_frontend`. No Dockerfile exists in either repository.
- [ ] Root CI restored and green (Standing debt). Hub backend and frontend already run checks in their deploy workflows.

## Decisions

- **The Hub keeps its own fonts (Inter and JetBrains Mono) on purpose**, so it is recognisable as the Hub rather than a server's dashboard. Tokens, spacing, components and patterns stay shared. (`docs-ui/decisions.md`, 2026-11-19; `docs-rev/fix-report-5.md`.)
- **`docs-ui/` at the workspace root is gitignored local knowledge for agents**, and every UI change updates it in the same change. (`docs-ui/README.md`; `.gitignore`; CLAUDE.md rule 30; root and `hub_frontend` `AGENTS.md`.)
- **Orchestration:** Claude Code orchestrates; OpenCode (DeepSeek V4.1 Flash) implements in parallel; Qoder session `ad305533-e113-4e82-b4ba-d36431a31445` for UI review; HIGH-risk security cores are written by the orchestrator.
- **Release process:** see "Versioning policy — Release process (decision)". Manual `npm-publish.yml`; e2e locally until Linux CI is fixed.

## Standing debt (root package and CI)

- `process.platform` outside `core/platform.js`: 11 occurrences in 8 files — `core/cert-suggest.js`, `cli/managers/node-manager.js`, `dashboard/socketManager.js` (2), `cli/menus/dashboard.js`, `dashboard/controllers/domainsController.js`, `core/deploy/engine.js` (3), `core/purge.js`, `core/shell.js` (1). That is 10 occurrences in 7 files if `core/shell.js` is excluded too (CLAUDE.md rule 3).
- `child_process` imported outside `core/shell.js`: 4 files — `dashboard/socketManager.js`, `dashboard/controllers/updateController.js`, `core/dashboardProcess.js`, `core/deploy/launcher.js` (CLAUDE.md rule 2).
- Real-machine checks still due: Windows Server mode, systemd, runtime update, purge, `curl | bash`, real PM2 deploys, and a Let's Encrypt staging run.
- **Make the e2e suites pass on a Linux CI runner and restore `ci.yml`.** `.github/workflows/ci.yml` is removed from git for now. Its first ubuntu run failed 6 suites that pass locally:
  - `pairing-smoke` and `domain-sync` — `hub_backend` is a separate private repo, not in the checkout.
  - `hub-agent` — the runner has nginx, so a config save the test expects to fail succeeds.
  - `native-service` — Windows-only legacy cleanup checks run on Linux, and a symlink is created before its parent folder exists.
  - `nginx-websocket-cloudflare` — `path.basename` on a simulated Windows path under Linux.
  - `security-hardening` — `stopDashboard` command-line matching; see the 1.4.x patch item.
- An ESLint config for the docs site so its CI can lint (`docs/.github/workflows/ci.yml` builds only today).
- An account whose email equals `DEV_EMAIL` can only sign in with `DEV_PASSWORD` (`hub_backend/src/Service/user.ts`, `verifyCredentials` checks the dev identity before the database).
- Declining the CLI's replace-link prompt still uses up the one-time link (harmless; `docs-rev/fix-report-4.md`, "Accepted limits").

## Later / maybe

- Browser tests (Playwright) for both UIs.
