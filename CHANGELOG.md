# Changelog

All notable changes to Easy DevOps are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

#### Deployments: domains, a configurable folder, moving an app, and an ez.json guide
- **Link an app to a domain.** From the app's "Domain & folder" tab: a new name
  is created, an existing domain is re-pointed at the app's port. It goes
  through the same domain path as everything else (`handleHubDomainCommand`),
  so nginx is tested and the previous config restored if it is rejected. A
  certificate can be requested in the same step; if it cannot be issued the
  link stands over HTTP and the answer says why. **A deployment that changes
  the app's port moves the linked domain with it** — otherwise nginx would keep
  proxying to a port nothing listens on.
- **Deleting an app asks about its domain.** Unticked by default: the domain is
  kept unless you say otherwise. If the domain cannot be removed the app is
  still deleted, with a warning.
- **The deployments folder is a setting** — `deployDir`, default
  `<data dir>/ez_deploys`, in the dashboard and the CLI. **Changing it never
  moves an existing app.** Each app records the folder it was created in and
  keeps using it; apps created before this release stay in
  `<data dir>/deploy/<id>` and are found there.
- **Move an app.** Give a folder: the PM2 process is stopped (on Windows a
  folder in use cannot be moved at all), the folder is moved to
  `<folder>/<app>` — a rename, or a copy across disks — the new location is
  recorded, each release's PM2 config is pointed at its new path, and the live
  release is started again. If the move itself fails nothing has changed and
  the process is started where it was. A destination that already has files in
  it is refused.
- **An ez.json tab** on every app: the file written out from what that app
  deploys with today (copy or download), where to put it, what each field
  means and what happens without it, and a non-Node example. The GitHub tab
  gains a short "how it works".
- All of it from the Hub too (`linkDomain`, `unlinkDomain`, `move`, `delete`
  with `deleteDomain`), under `deploy.manage` — plus `domains.create` /
  `domains.edit` to link and `domains.delete` to remove a domain, because
  managing apps does not imply managing domains. No certificate is requested
  from the Hub's link action; that stays `ssl.issue`.

Contract 2.6.0.

#### Deployments from the Hub, CI through the Hub, and automatic GitHub setup
The second half of Deployments: everything the local dashboard can do, from the
Hub, under permissions the server's owner sets — and two ways to stop copying
things into GitHub by hand.

- **A Deployments section on the Hub's server page.** The app list, deploy, roll
  back, deployment logs, create/edit/delete an app, edit environment variables,
  and the GitHub setup. Every action is a `hub:manageDeploy` command checked on
  the server.
- **Six new permissions, all off by default** (Settings → Hub): `deploy.run`,
  `deploy.rollback`, `deploy.logs`, `deploy.manage`, `deploy.env`, `deploy.ci`.
  Environment values are their own permission on purpose — "may create an app"
  does not include "may read its secrets" — and creating or editing an app from
  the Hub ignores `env` entirely.
- **What the Hub is sent.** The app list is monitoring, like the process list,
  and is the *public* view: names of environment variables, never values, and no
  credentials. Values leave the server only through `getEnv`, to the person who
  asked, and are not stored by the Hub. A deploy key cannot be generated from
  the Hub at all: its private half never leaves the server.
- **CI through the Hub ("option B").** A GitHub Action can call the Hub instead
  of the server; the Hub forwards the request down the agent connection the
  server already holds open, so the server needs **no inbound port and no public
  domain**. The credential is the app's own deploy token and **the server
  verifies it** — the Hub stores no token and cannot mint one. The workflow file
  is identical to the direct one; only the `EZ_DEPLOY_URL` secret differs. The
  dashboard's GitHub tab offers both and says which are usable.
- **"Do it for me" on GitHub.** For a github.com repository the dashboard stores
  both secrets, commits the workflow file and adds the deploy key read-only,
  given a GitHub token with write access. Each step is reported on its own, so
  a token that may write secrets but not workflows still gets the secrets in
  place and the answer names the step that is left. The deploy token is issued
  for the occasion, goes straight into the repository's secrets and is never
  shown. The manual steps remain underneath.

**Two new dependencies, by explicit decision:** `tweetnacl` and `blakejs`.
GitHub only accepts a secret encrypted as a libsodium sealed box (X25519 +
XSalsa20-Poly1305 with a BLAKE2b-derived nonce), which Node's crypto cannot
produce. Both are small, pure JavaScript and dependency-free, and are used in
`core/deploy/githubApi.js` only.

Contract 2.5.0. In `hub_backend`: `routes/api/v1/hooks.ts`, `requestAgent()`
and the `deploy:apps` relay in `agentServer.ts`.

#### Deployments — put a project on the server and keep it deployed
A new **Deployments** section in the dashboard. Give it a git repository; it is
fetched and built on the server, run under PM2, and the previous release is
kept one step away. All of it is `core/deploy/`, so the Hub can reach the same
behaviour later without going through HTTP.

- **One deployment:** fetch into `releases/<id>` → settings → `pre` hook →
  install → build → stop the old process, start the new one (`ez-<name>`) →
  health check → `post` hook → prune. **Nothing before the switch touches what
  is running**, so a broken build costs nothing.
- **Automatic rollback.** A release that starts but fails its health check is
  replaced by the previous release — the same files that were running, not a
  rebuild. Per app, on by default. A manual rollback to any release still on
  disk is one click.
- **`ez.json`, optional.** `install`, `build`, `start`, `port`, `health`,
  `hooks.pre` / `hooks.post`, at `ez.json`, `deploy/ez.json` or
  `.deploy/ez.json`. Without one, a Node project is deployed from
  `package.json` (the lockfile picks npm, yarn or pnpm). With one, the commands
  run exactly as written — **any language**. Values set on the app override it.
  A mistake in the file stops the deployment before anything is touched.
- **Private repositories:** a per-app SSH deploy key generated in-process (no
  `ssh-keygen` needed; the private half is never returned by any endpoint), or
  an access token passed to git as a per-command header so it is never written
  into a checkout or a log.
- **Environment variables** per app, stored on the server only.
- **GitHub Actions.** The dashboard generates the workflow file and lists the
  two secrets it needs. The workflow waits for the outcome, so a failed
  deployment is a red check on the commit. It uses no third-party actions.
- **The deploy hook** that the workflow calls is a separate, opt-in listener
  (`core/deploy/hookServer.js`) that runs with the background jobs — the
  dashboard is on demand, and a deployment trigger cannot be. It is **off by
  default**, binds to loopback, and serves only `/.ez-deploy/`. Expose it
  through one of your domains (one nginx location, HTTPS when the domain has a
  certificate) or directly on its own port (plain HTTP, and the UI says so).
  Each app has its own token — 256 random bits, stored as a hash, shown once —
  that can start a deployment of that app from its configured repository and
  nothing else. Failed attempts are rate-limited per client, and an unknown app
  is indistinguishable from a wrong token.
- One deployment per app at a time, enforced by a lock file, because the
  dashboard and the background service are different processes.
- Contract 2.4.0 (`/api/deployments/*`), `e2e/deploy.test.mjs`.

**This reverses one earlier decision, deliberately:** the daemon used to open no
port at all. It still opens none unless the deploy hook is switched on.

**Not in this release:** zero-downtime switching (the switch is a restart),
static sites served straight from nginx, creating the GitHub secrets through
GitHub's API (it needs libsodium sealed boxes — a new dependency, so a
decision), and triggering deployments from the Hub.

`core/shell.js` gained `runCommandLine()` for commands a user wrote (it runs
them in the platform's default shell, where `&&` works on Windows too), and
`run()` accepts `env` and `onData`. `core/runner.js` gained `startConfig()`.

#### Automatic certificate renewal
A certificate used to be renewed only when someone pressed a button. The daemon
watched expiry and warned about it — twice a day, from 30 days out — but did
nothing, so an unattended server still served an expired certificate.

- **HTTP-01 certificates are now renewed in the background, 7 days before they
  expire.** `sslAutoRenew` (default on) and `sslAutoRenewDays` (default 7, 1–30)
  are in Settings in the dashboard and the CLI, and need no restart. An install
  that predates the setting reads as on.
- **An unattended renewal never stops nginx.** `sslChallengeMode: auto` may fall
  back to standalone mode, which is fine when someone is watching and not fine
  at an arbitrary hour on every site the server hosts. On a running nginx the
  job is pinned to proxy mode: if the local preflight fails, the attempt fails
  and a notification says why. An explicit `standalone` setting is still
  respected.
- **DNS-01 certificates — every wildcard — are not renewed automatically.** They
  need a TXT record a person adds. They keep the expiry warning, which now says
  they must be renewed manually.
- **A certificate no enabled domain serves is left alone.** Leftovers in the
  certificate directory usually no longer point here, and retrying them would
  spend Let's Encrypt's failed-validation budget on certificates nobody uses.
- **Attempts are spaced at least 6 hours apart, and the attempt is written down
  before issuance starts.** The job also runs at every daemon start; without
  this a crash-looping service would retry a failing domain on every restart.
- **You are told either way.** "Renewed" and "renewal failed: <reason>" go to
  the channels already configured for that domain's `cert_expiry` event.
- **The expiry warning stops repeating for certificates that are covered.** One
  that will be auto-renewed is not warned about until it is inside its window
  and still not renewed. Unused, DNS-01 and (with the setting off) all
  certificates are warned about exactly as before.
- `GET /api/ssl` reports each certificate's plan (`autoRenew`: `auto` | `manual`
  | `unused` | `off`) and last attempt; the SSL page shows it. Contract 2.3.0.

All of it is `core/cert-renewal.js`, with `e2e/cert-renewal.test.mjs` covering
the decisions against real certificates and injected issuance.

### Fixed

- **A renewal dropped `www`.** Every renew path — dashboard, CLI, Hub —
  re-issued for the bare domain, so a certificate issued with `www` came back
  without `www.example.com`. The names are now read from the certificate being
  replaced.
- **nginx kept serving the old certificate after a renewal.** Proxy mode never
  stops nginx, and nothing reloaded it either. It is reloaded now, and the
  result reports `nginxReloaded`.
- **"Renew" on a wildcard replaced it with a single-name certificate.** It is
  refused with `manual_renewal_required` instead.
- **The Hub showed every enabled domain as healthy.** The agent sent the
  `enabled` flag as the health result. It now sends the real probe result from
  the monitors, with `enabled` as its own field; the Hub no longer infers one
  from the other (it still does for an older agent, which has no other way to
  say it).
- **`Metric.nginxStatus` was always `unknown`** in the Hub. It records the last
  state the agent reported on that connection.
- `core/cert-operations.js` no longer imports from `cli/` — it calls
  `core/ssl-issuer.js` and `core/cert-renewal.js` directly.

### Added (earlier in this cycle)

#### `ezz runtime update` — move the service onto a newer Node, safely
The service is pinned to one Node binary on purpose, so upgrading Node never
reached it: it kept running the old binary until something re-pointed it by
hand, which meant editing a unit file or copying an exe into ProgramData and
finding out at the next restart whether the native modules still loaded.

- **The new runtime is smoke-tested before anything is touched** — while the old
  one is still in place and the service is still running. Three checks in
  increasing cost: it runs and meets the `engines.node` minimum, it can load
  `better-sqlite3` (the usual failure: an ABI built for another Node), and it
  can execute the CLI entry point, against a throwaway data directory so a
  smoke test can never read or write the real one. A failure here leaves the
  service up and reports that nothing was changed.
- **Then: stop, swap, start, and wait for the daemon's own heartbeat** — not the
  service manager's "started", which only means a process was spawned. Any
  failure rolls back and restarts: Linux re-points the symlink, Windows Server
  restores `node.exe.prev`, Windows Personal re-records the previous path.
- **The target is a version manager's LTS list, or the Node already installed.**
  With nvm or nvm-windows present it offers their LTS versions and installs the
  chosen one. With no version manager it offers the system Node (MSI, apt, brew)
  and re-pins the service to it; when that is already the pinned version it says
  there is nothing to update and prints how to upgrade Node. **It never downloads
  a runtime**, and **it never uninstalls a Node version** — the old one is what a
  rollback needs.
- **Windows Server mode also fixes the app copy's native modules.** The copy
  under ProgramData holds `better-sqlite3` built for the old ABI; pairing it
  with a new `node.exe` fails at require time with an error that never mentions
  Node versions. It is rebuilt in the copy, and if that fails (no build tools,
  normal on a server) the modules are refreshed from the package.
- A runtime change under ProgramData is **refused before anything is stopped**
  when the terminal is not elevated, with the command and "Run as administrator".
  No password, in any mode.

#### `ezz update` — update Easy DevOps and restart the service
Non-interactive, and it shares one implementation with the interactive menu, so
a feature added to one cannot be missing from the other. That had already
happened: the menu's update never refreshed the Windows Server runtime copy, so
on Server mode an update replaced the package and left the service running the
old code.

- **A git clone is detected and npm is not run.** On a clone
  `npm install -g easy-devops` installs a second copy from the registry and
  leaves the service running the clone — the update would report success and
  change nothing. It now says so and prints `git pull`, `npm install`,
  `ezz service restart` instead. Deciding that is `core/installSource.js`, and
  `ezz runtime update` surfaces the same fact in its status.
- Stop, replace, refresh the Server-mode copy, start, then confirm the version
  the running daemon itself reports. On failure the previous version is
  reinstalled and the service restarted.
- The output explains why this is not available from the dashboard or the Hub:
  the process that performs the update is the one being stopped and replaced, so
  it could not report what happened.

#### `ezz cleanup` — see what can be reclaimed, then choose
Dry run first, always: the inventory is printed with a size per item before
anything is offered, and `scan()` has no path that deletes.

- Groups: old runtime backups (**the newest of each kind is kept**, so the last
  change can still be undone), Easy DevOps logs older than N days (`--days N`,
  default 14), temporary files, stale notification claims and a provably dead
  daemon lock, `.bak` files in the nginx config directory, PM2 logs (via
  `pm2 flush`, because PM2 holds the files open), and installed Node versions.
- **Never listed, so they cannot be selected either:** the database and its
  `-wal`/`-shm` siblings, the settings, anything under `sslDir`, active `.conf`
  files, the pinned runtime, the version manager's default, any Node version a
  PM2 app runs, a live daemon lock, and `daemon.stop` — a pending stop request is
  a deliberate state, not litter, and removing it would restart a service the
  user stopped on purpose.
- Node versions are **listed only**, each with the evidence for whether anything
  refers to it; nothing there is selected by default, and `--yes` never touches
  them or PM2.
- A scan runs **no pm2 command at all** when PM2's daemon is down, because every
  pm2 command would start one.

#### `ezz uninstall --purge` — remove Easy DevOps, keep the web server
Plain `ezz uninstall` now explains the difference between removing the service
and removing Easy DevOps, and does nothing else; the destructive reading has to
be asked for.

- **The backup comes first and is not optional.** The data directory is copied
  outside itself with a `MANIFEST.txt` explaining how to restore, the copy is
  verified to contain the database, and the path is printed. If the backup fails,
  **nothing is removed at all.**
- Then the service, the pinned runtime (on Linux the link only — never the Node
  it points at) and the data directory. **nginx, your sites and your
  certificates are kept**; certificates are an explicit question whose default is
  keep. It finishes with the one command it cannot run itself —
  `npm uninstall -g easy-devops` — because npm would be deleting the files it is
  running from.

#### A one-time setup code protects first-run setup
`POST /api/setup` is public by necessity — there is no session before the first
password exists — so on a freshly started dashboard whoever reached that endpoint
first owned the installation. The transport checks stop a hostile page in the
user's browser but nothing stops a direct request from anything that can reach
the port, which on a server bound to `0.0.0.0` is the network.

- Six digits, shown as `418 902` and accepted with or without the space, printed
  to the terminal and to the service log. Required to set the first password;
  **not** required for the loopback-only "no password" choice, which is already a
  stronger constraint.
- Stored as a scrypt hash and compared with `timingSafeEqual`, like a password.
  Expires after 24 hours. Rate-limited per IP in **its own budget**, so setup
  guesses cannot exhaust the login budget or the reverse. After **20 failed
  attempts across all addresses** the code is burned and only
  `ezz dashboard setup-code`, run on the machine, issues another — that global
  cap is what makes six digits defensible.
- **It never leaves the machine**: not in `GET /api/auth` (which reports only
  *whether* one is required, and when it expires), not in any other response, not
  in a Socket.io event, not in the Hub agent's payloads, and not in the
  downloadable settings backup. A test enumerates every payload and also fails if
  any file outside a named five gains the ability to read the code at all.
- The new dashboard UI already had the field and sent `setupCode`; it was dead
  against the real API. Contract 2.1.0.

#### Starting and stopping the background service from the dashboard
`POST /api/service/start`, `/api/service/stop` and `/api/service/restart`, behind
the same auth gate as every other route. They work in Personal mode, where the
dashboard runs as the same user as the daemon. Where the action genuinely needs
elevation — the Windows service in Server mode, or systemd — the answer is a
`403 elevation_required` carrying the **exact command and the shell to run it
in**, never a password prompt. `409` distinguishes the two preconditions worth
telling apart: `not_installed` and `already_running`.

#### `service:changed`, so an open tab knows who owns the jobs
A Socket.io event carrying the full background-service state, emitted whenever
it changes: a daemon started or stopped, a stop you asked for, or a hand-over of
the jobs. It is **replayed on connect** alongside `nginx:status` and
`domain:health`, because the service is already running or not when a tab opens
and nothing else would say so until the next change. Only published on a real
change, so an ordinary service restart does not flicker the banner. Payload is
the same object `GET /api/service` returns under `backgroundService`, so the UI
has one shape to render. Contract 2.0.0.

#### An exclusive marker for the jobs, separate from the daemon lock
`core/jobs/owner.js`. The daemon lock answers "is a daemon running"; this
answers "who is running the jobs right now", which is a different question
because the dashboard deliberately never takes the lock. The owner writes a pid
and a heartbeat, claims before starting anything, and releases last — after the
Hub agent and the monitors are down.

#### Editing nginx configs from the Hub
`hub:saveConfig` is now dispatchable: the agent has always implemented it and
both permission maps routed it to `nginx.config.edit`, but the Hub's
`ALLOWED_COMMANDS` did not list it, so `POST /servers/:id/command` answered
`400 Unknown command`. The config editor in the Hub UI was blocked behind that.

- **The allow-list is now the single source of truth** (`src/Types/index.ts`)
  and the request type is derived from it. The two were maintained separately
  and had drifted: the type still named three commands long after
  `hub:getConfigs` and `hub:getLogs` were allowed. A test now asserts every
  listed command has a permission mapping.
- **Optional `reload: true`** on `hub:saveConfig`. The agent writes the file,
  runs `nginx -t`, and **restores the previous bytes if the test fails** as
  before. A reload afterwards is gated **separately** on `nginx.reload`: with it
  granted, nginx is reloaded; without it the config is still saved and tested,
  not reloaded, and the result says why. The Hub deliberately does not refuse
  the command in that case — saving is permitted on its own, and a server that
  allows editing but not reloading has said something specific. Only a real
  boolean `true` asks for a reload, since it affects live traffic. A reload that
  fails does not undo the save: the file has already passed `nginx -t`.
  The result carries `reloadRequested`, `reloaded` and `reloadDetail`.

#### `ezz daemon` — background work that survives closing the dashboard
Monitoring, notifications and the Hub agent no longer require an open browser.
They were driven by intervals inside the dashboard's socket layer that only ran
while a client was connected, so closing the window silently stopped
everything — and nothing said so.

- **`ezz daemon`** runs them in the foreground with **no HTTP port**.
  Foreground because every service manager wants a process it can watch; no
  port because a daemon that monitors does not need one, and a port would need
  its own bind policy, authentication and firewall story.
- **The jobs run in exactly one process.** The daemon takes a single-instance
  lock (pid + heartbeat in the data directory) and runs them while it holds it.
  An open dashboard never takes the lock: it runs them only while no daemon
  does, polls every 15 seconds, and hands over in either direction. Without
  this, a user with no service installed would lose monitoring entirely.
- **Live events reach the dashboard over local IPC** — a named pipe on Windows,
  a Unix socket in the data directory elsewhere. The channel is **one-way and
  accepts no commands**: the daemon may run as a service account with access the
  dashboard user lacks, so a channel that cannot be asked to do anything cannot
  be used to escalate. Changes travel back through the existing revision
  counter in SQLite.
- **`ezz --dash` now says which situation you are in** — that the background
  service is running and the dashboard is only an interface, or that monitoring
  is running in this window and will stop when it closes, with the install
  command.
- **`GET /api/service`** gained a `backgroundService` object
  (`running`, `connected`, `pid`, `version`, `startedAt`, `jobsRunningHere`)
  for the dashboard banner, plus a structured `install`
  (`command`, `needsElevation`, `shell`) alongside the prose `cliHint`.
  Contract 1.2.0.

#### A native OS service, and never a password again
`ezz service install` now registers a real service for the platform, running
`ezz daemon` rather than the dashboard. PM2 is no longer involved in running
Easy DevOps itself.

| platform / mode | mechanism | elevation | starts |
|---|---|---|---|
| Linux | systemd unit | sudo once | at boot |
| Windows "Server" | Windows Service via WinSW | UAC once | at boot |
| Windows "Personal" | Startup-folder supervisor | none | at logon |

- **No password is ever requested, stored or passed through.** On Linux sudo
  asks for its own, on your terminal. On Windows the service runs as the
  virtual account `NT SERVICE\EasyDevOps`, which has no password at all. **The
  Task Scheduler mode that needed your Windows password is removed**; install
  and uninstall now offer to clean up what it left behind (the `ez-dashboard`
  PM2 app, the `EasyDevOps-PM2` task, the old startup launcher). PM2 apps that
  are not ours are never touched.
- **`ezz service repair`** is new: it re-pins the Node runtime, re-applies the
  Windows permissions and restarts the service. It is what the status warnings
  point at.
- **The Node runtime is pinned**, so a version manager cannot break the service
  weeks later. A symlink on Linux, a copy into `C:\ProgramData\easy-devops` on
  Windows Server, a recorded absolute path in Personal mode. `ezz service
  status` shows the service's Node next to the system's, warns when
  nvm-windows and the MSI installer are both present, and on a native-module
  ABI mismatch says exactly what to rebuild.
- **Starting is verified, not assumed.** WinSW and systemd both report success
  as soon as a process is spawned, so install waits for the daemon's own
  heartbeat and reports FAILED with the last log lines if it never arrives.
  `status` flags a crash loop — from `NRestarts` on Linux, and from WinSW's
  wrapper log on Windows, because `sc query` reports RUNNING between restarts.
- **WinSW is pinned and hash-verified**: `WinSW-x64.exe` v2.12.0, SHA-256
  checked against a constant computed from the real download. Install refuses
  on a mismatch rather than warning and continuing — the binary is about to be
  registered as a service.
- **Windows Server mode moves the data to `C:\ProgramData\easy-devops`** for
  the service, the CLI and the dashboard alike, because a service account
  cannot read the installing user's `%APPDATA%`. It is migrated once: copied,
  verified file by file, and the original kept as a timestamped backup. It
  refuses to run while a daemon holds the directory, and refuses to overwrite a
  destination that already has a database. **Uninstall never silently moves it
  back** — it asks, and the default is to keep the server location.
- **The service account's permissions come from Settings**, never a hardcoded
  `C:\nginx` or `C:\ssl`. The granted paths are recorded and compared on every
  `status`, so changing one in Settings tells you to run `ezz service repair`
  instead of leaving a service that quietly cannot read its own config.
- **`install.sh` and `install.ps1` offer it at the end**, with `--service` /
  `--no-service` (`-Service` / `-NoService`) for unattended runs. The Linux
  prompt reads from `/dev/tty`, so it works under `curl … | bash` where stdin
  is the pipe carrying the script. With no terminal at all, both installers
  print the command rather than guessing — the question can run sudo, so
  guessing yes is the wrong direction. On Windows, Server mode relaunches just
  the service install through UAC; declining the prompt is treated as an
  answer, not an error.

#### New dashboard UI, behind a flag
The React dashboard built earlier is now wired into the server, without
changing the default. The classic EJS page is still what every install serves
unless it asks for the new one.

- **`ezz --dash --new-ui`** serves the built React app from `dist/ui`. The flag
  combines with `--dev` and overrides the setting below for that run.
- **`dashboardUi: "classic" | "new"`** in the settings, default `classic`, so a
  background service can select the UI on each boot without a flag. It takes
  effect on restart; `--new-ui` does not need one. Exposed by
  `GET /api/settings` and accepted by `POST /api/settings`, which reports
  `needsRestart`.
- **Serving.** In new mode `dist/ui` is served at `/` with an `index.html`
  fallback for deep links and immutable caching for built assets.
  `/api` and `/socket.io` are mounted exactly as before; static files are
  public, and every API route and socket handshake keeps the session,
  Host/Origin, `X-EZ-Request` and bind-address rules in both UI modes.
- **Missing build.** If the new UI is requested before `npm run build:ui` has
  produced `dist/ui`, the server prints the expected path and that command, and
  serves the classic UI for that run instead of failing to start.
- **Build and packaging.** `npm run build:ui` installs and builds the UI;
  `prepublishOnly` runs it before `npm test`. The published package ships
  `dist/ui` and excludes the `src/dashboard/ui` sources and its
  `node_modules`; `dist/ui` and `src/dashboard/ui/node_modules` are ignored by
  git.
- **Tests.** A suite covers classic by default, the flag and the setting, the
  SPA fallback, the missing-build fallback, and every registered `/api` route
  still returning 401 without a session while the new UI is on.

#### Background service (via PM2)
Easy DevOps no longer needs a terminal left open. PM2 keeps the dashboard
running, restarts it after a crash, and brings it back after a reboot; Easy
DevOps manages PM2 on your behalf and never implements its own daemon.

- **`ezz service install | uninstall | status | restart | logs`**. Install
  starts the dashboard as the PM2 app **ez-dashboard** (or **ez-dashboard-dev**
  under `--dev`/`EASY_DEVOPS_DATA_DIR`, with the data directory carried into
  the saved process list), runs `pm2 save` so a reboot can restore it, and
  offers `pm2-logrotate` so PM2's own logs cannot fill the disk. **Nothing is
  installed without asking.**
- **Start on boot, per platform.**
  - *Linux / macOS*: `pm2 startup` detects the init system and prints the
    command to run as root. Easy DevOps shows it rather than running it, so this
    needs no sudoers rules at all.
  - *Windows*: `pm2 startup` is unsupported, so install offers two modes.
    **Personal/dev machine** drops a hidden launcher in the Startup folder
    running `pm2 resurrect` — no administrator rights, no password, but it
    starts at logon and stops when you sign out. **Server** creates a Task
    Scheduler task at system startup as the same user with a 30-second delay,
    which survives a reboot with nobody logged in. Windows Server is detected
    (`Win32_OperatingSystem.ProductType`) and defaults to Server mode;
    otherwise you are asked.
- **Easy DevOps never sees your Windows password.** The server-mode task is
  created with `schtasks /RP *`, which makes *Windows* prompt for it and store
  it in its own credential vault. The password is not in the command, not in
  argv, not in the database and not in any log line — asserted by a test. That
  is also why server mode is CLI-only and needs an elevated, interactive
  terminal; the dashboard reports the status and tells you to run
  `ezz service install` in an Administrator PowerShell.
- **Same-user checks.** PM2 keeps one process list per OS user, so a service
  installed by another account cannot be controlled at all. The CLI, the
  dashboard and the Hub all say so explicitly instead of silently doing nothing.
- **Visibility everywhere.** `ezz service status` and the dashboard (Settings
  and the new Processes page) show installed / running / start-on-boot and which
  mechanism is in use. The agent reports the same to the Hub, where the server
  page shows it — so a server running as a service with boot enabled means
  "offline" is a real outage rather than a closed terminal.
- **Updates.** `npm update -g easy-devops` through the CLI now restarts the
  service instead of killing it by pid: PM2 owns the process, so a kill would
  only revive the old code, and a detached copy would fight it for the port.
  The Dashboard menu defers to the service when one is installed.
- **New dashboard page: Processes.** Lists every PM2 app with status, CPU,
  memory, uptime and restart count, with start / stop / restart / logs. Apps
  Easy DevOps created are labelled; anything else is listed but asks for
  confirmation before being stopped or restarted, because it may be an
  unrelated production app sharing that PM2. These endpoints are behind the
  dashboard session check.
- **Hub:** a read-only process list and service panel on the server page.
  Acting on a process remotely is in the permission tree as **coming soon**
  (`process.start`, `process.stop`, `process.restart`).
- **Uninstall never breaks anyone else's start-on-boot.** The boot mechanism is
  shared — one systemd unit, one scheduled task, one Startup launcher, each
  just running `pm2 resurrect`, which restores *every* saved app. Uninstall
  removes its own app and re-saves, but tears the mechanism down only when PM2
  has no other apps left; otherwise it keeps it and names the apps it is
  protecting. If the app list cannot be read at all it also keeps it, because
  leaving a hook behind is recoverable and breaking someone's reboot is not.
- **Detecting start-on-boot never runs `pm2 startup`.** That command is not a
  query: given the rights to act it installs the hook, so using it to read
  state would silently enable start-on-boot during a status check — and start
  the PM2 daemon as a side effect. Detection reads
  `systemctl is-enabled pm2-<user>` instead, and reports **unknown** rather
  than guessing on systems that do not use systemd. The CLI, the dashboard and
  the Hub all render that third state rather than showing it as "no".
- **`status()` is cached for 60 seconds**, and invalidated immediately by
  install, uninstall and restart. A status read shells out several times, and
  the dashboard, Settings and the Hub agent all ask for it.
- **A failed replacement says so.** `install` deletes the existing app before
  starting the new one; if the start then fails, the result reports that the
  previous service was removed and that nothing is running now, instead of
  leaving the user to discover it.
- No new npm dependencies: PM2 and pm2-logrotate are installed into the user's
  environment, and the Windows paths use `schtasks` and the Startup folder,
  both built in.

### Changed

- **`GET /api/service` now describes the native service explicitly, and the
  PM2-era fields are gone.** `backgroundService` reports the mechanism, whether
  it is installed, whether it starts at logon or at boot, whether it was stopped
  by you and when (local time), the service's own Node runtime and path against
  the system Node, and any warnings. The top-level `installed`, `running` and
  `enabledOnBoot`, and the `ez-dashboard` app they described, are **removed**:
  on a machine where the native daemon was running they read
  `installed: false, running: false`, so a client that trusted them rendered
  "Not installed" over a working service. A missing field is better than a wrong
  one. `pm2` stays — it still describes the user's own apps on the Processes
  page. Contract 2.0.0, and its service sections are rewritten: they still
  described Task Scheduler and a password.
- **The superseded `core/service.js` is deleted.** The PM2 install/uninstall
  path it held was replaced by `core/service/` and nothing routed to it any
  more; the coverage that still mattered — that a status read never starts a PM2
  daemon — moved into the native-service suite.
- **CLI polish on the service commands.** `ezz service uninstall` with nothing
  installed now says so and stops, offering the legacy PM2 cleanup only when
  legacy items actually exist. `ezz service install` ends by offering to start
  it (default yes) through the same path as `ezz service start`, rather than
  suggesting `ezz daemon`, which runs in the foreground and is not what someone
  who just installed a service wants. Times are shown in local time and
  human-readable (`2026-11-14 23:21`) instead of ISO UTC.

- **The React dashboard is now the default UI.** `dashboardUi` defaults to
  `new`, and the one-run override is `--classic-ui` rather than `--new-ui`
  (which is still accepted, prints a note, and does nothing). The classic EJS
  page remains as a temporary fallback and its files are not removed — an
  operator who hits a regression needs a working dashboard in the same minute.
  A stored `dashboardUi: "classic"` from before this change is migrated to
  `new` **exactly once**, recorded by `dashboardUiMigrated`; after that, a
  deliberate `classic` is never overridden. A missing `dist/ui` build still
  prints `npm run build:ui` and falls back to classic rather than failing to
  start. The daemon serves no UI at all.
- **Background work moved out of the dashboard into `core/jobs/`.** nginx
  polling, domain health, certificate expiry, the notification decisions, the
  revision watcher and the Hub agent now run in whichever process owns them.
  `dashboard/socketManager.js` does no monitoring at all: it forwards job-bus
  events to browsers and owns the live log tails, which are per-client by
  nature. The browser-facing event names and payloads are unchanged.
- **The Hub agent follows job ownership** instead of being started by the
  dashboard directly. Two agents on one pairing would both receive every Hub
  command and both execute it.
- **A newly connected dashboard is sent the last known `nginx:status` and
  `domain:health` immediately.** The old code ran a fresh poll per connection,
  which is impossible when the polling happens in another process and meant
  every opened tab triggered real work. `notification:new` is deliberately not
  replayed — a new tab must not be told about outages that are already over.
- **`GET /api/nginx/logs` takes `?file=error|access` and `?lines=N`** and
  returns `{ lines, file }`. Additive: with no parameters it returns 100 lines
  of the error log, exactly as before. The access log was unreachable until now,
  despite the contract always describing this endpoint as access/error.
- **Moved into `core/` so the daemon can use them** (core must not import from
  `dashboard/`): `nginx-service.js`, `cert-reader.js`, `domains-db.js`,
  `cert-operations.js`, and `hubAgent.js` → `core/hub/agent.js`. Two of these
  also removed existing violations where `src/cli/managers/` was importing from
  `dashboard/lib/`. No behaviour change.
- **`core/db.js`: PM2 status reads never start the PM2 daemon.** Every pm2
  command — `pm2 --version` included — starts the daemon if it is not running.
  Status reads now check the daemon's pid file first and skip PM2 entirely when
  it is down, so opening the dashboard or having the Hub agent report in cannot
  spawn a PM2 daemon on a machine that does not use PM2.
- `shell.js`'s `runInteractive` is documented as cross-platform rather than
  Linux-only: Windows needs it so `schtasks` can prompt for the password. The
  implementation is unchanged; callers must check `process.stdin.isTTY`.
- The CLI argument parser keeps every positional argument, not just the first,
  so `ezz service install` can be dispatched.

### Fixed

- **`GET /api/service` took about 20 seconds on Windows.** Nothing in it was
  slow by itself; it was the spawn count. Measured on the machine that reported
  it: one `run()` through PowerShell costs **0.9–1.4 s**, `where.exe pm2` 2.0 s,
  `pm2 --version` 4.0 s, `schtasks /Query` 1.7 s — and the endpoint made about
  six of them, one after another (the service manager's status, the pinned
  runtime's `--version`, the legacy PM2 scan, which itself detects PM2 and lists
  its apps, and PM2 detection again for the Processes panel).

  Three changes, in order of how much each is worth:

  - **The expensive probes are cached and refreshed in the background**
    (`core/probeCache.js`). A request is answered from the cache, even a stale
    answer, and the refresh happens behind it; only a probe that has never run
    can make a request wait, and then only until a deadline. These probes
    describe things that change when the user runs a command — whether PM2 is
    installed, which Node the service is pinned to — never on their own.
  - **The probes that do run, run in parallel.** Five spawns sequentially cost
    ~6 s on that machine; the same five together cost ~1.7 s. This also speeds
    up `ezz service status` in the terminal, which deliberately does **not**
    use the cache: 7.5 s to about 2 s.
  - **The cheap state is served immediately.** The daemon lock, its heartbeat
    age, whether a stop was requested and what install recorded cost
    microseconds, and they are the facts that change on their own. They are
    read fresh on every request and never cached.

  Measured after the change: a warm call **3 ms**, the first call after start
  **1.6 s** — and the dashboard warms the probes when it starts, so in practice
  the first page load is warm too. The cache is dropped whenever the answer
  could have changed: the three lifecycle endpoints, `ezz service install`,
  `uninstall` and `repair`, a runtime update, and `service:changed`, which
  covers a start or stop made in another process. A per-probe TTL is the
  backstop for a change made outside Easy DevOps, such as `sc stop`.

  `GET /api/service` gained a `probes` object (`ageMs`, `fresh`, `pending`,
  `refreshing`) so a client can tell a measured answer from one still being
  measured. While `pending` is true only the measured fields are absent —
  `state`, `enabledOnBoot`, `restarts`, `crashLooping`, `runtime` — and
  everything the banner needs is already real. Contract 2.2.0.

- **`install.sh` could not find its own modules, from a clone or from
  `curl | bash`.** It looked for them at `lib/installer`, which exists neither in
  the repository nor in the published package — they live at `src/lib/installer`
  — and its GitHub fallback URL had the same wrong path. So both routes failed,
  and the failing route then `mkdir -p`'d an empty `lib/installer` into whatever
  directory the user happened to be standing in. Now: every real layout is
  searched (the package, a clone, an older checkout), the fallback URL points at
  `src/lib/installer`, a download goes to a `mktemp -d` directory that is cleaned
  up on exit rather than into the current one, and `--help` is answered **before**
  any of that, so asking for help costs no network request and writes nothing.
  Piped execution is also detected: with `curl | bash` there is no script
  directory, and the current directory's `package.json` — which may belong to a
  completely different project — is no longer mistaken for an Easy DevOps
  checkout.
- **nvm-windows' LTS list was read from the wrong column.** `nvm list available`
  prints `CURRENT | LTS | OLD STABLE | OLD UNSTABLE`, and the row begins with a
  pipe, so index 1 of the split is the CURRENT column: the runtime picker offered
  23.x as "LTS". Found by testing the parser against real `nvm list available`
  output.
- **A leftover `%APPDATA%\nvm` directory made `nvm version` exit 0 with no
  output**, which was read as "nvm-windows is installed" and then produced an
  empty version list and a misleading "no newer LTS" message. A version probe now
  has to print something version-shaped to count as an answer.

- **Starting the background service while a dashboard was open made both of
  them own the jobs, and the Hub evicted them in turn.** The hand-over was a
  15-second poll, which is fine for noticing a daemon that went away and far too
  slow for one that arrived: for those seconds two processes each had a Hub agent
  connected with the same `serverId`. The hand-over is now immediate and
  exclusive — the dashboard watches the lock file with `fs.watch` instead of
  only polling, and the daemon waits (bounded) for the dashboard to release the
  jobs marker before it starts the Hub agent or any monitor. A test spawns a real
  daemon against a dashboard that is running the jobs and asserts zero evictions
  and exactly one live agent across the start and the stop.
- **After a new daemon started, the dashboard logged `no event channel
  (closed)` and took the jobs back.** The IPC client's reconnect backoff only
  reset inside the `connect` handler, so after a restart or two the next attempt
  was up to fifteen seconds away — correct for "no service is installed", wrong
  for "a daemon just appeared". The lock watcher now reconnects the channel
  immediately, and the disconnect message distinguishes "lost the channel to a
  service that is still running" from "the service is not running", which it
  previously conflated.
- **The daemon's console and log output is ASCII-only.** `Stopping…` arrived as
  `Stopping??` in a Windows console in the legacy OEM code page, and the same
  applies to the WinSW-captured log and the Startup supervisor's redirect. The
  ellipses and em dashes in the daemon's output are gone, and a test asserts
  both that the lines a real start and stop emit are clean and that no output
  string anywhere on the daemon's code path has a character above ASCII.

#### Five bugs found testing Windows Personal mode on a real machine

- **An installed service ran as a development instance and issued Let's Encrypt
  STAGING certificates on real domains.** `isDevDataDir()` was literally "is
  `EASY_DEVOPS_DATA_DIR` set?", and every installed service sets it so the
  service and the CLI agree on one data location. Dev mode is now decided by
  intent: `EZ_DEV=1` (what `--dev` sets) or a `.dev-data` directory. The
  variable is also no longer passed when the directory is already the default,
  in the logon launcher, the systemd unit and the WinSW XML — so a regression of
  either half alone cannot bring the bug back. The same conflation controlled
  `-dev` process names, and the legacy data migration, which now keys off "is
  this the default directory" — the rule it always meant.
- **The Windows Personal launcher ran in a visible console window for the whole
  session, and closing that window stopped the daemon** with no restart. The
  Startup entry is now a small bootstrap that starts the real supervisor with
  `Start-Process -WindowStyle Hidden` and exits — a brief flash, then nothing
  visible. The supervisor moved out of the Startup folder into the data
  directory. No VBScript, which endpoint protection now often blocks. The
  generated batch files are also pure ASCII: an em dash in a comment produced
  `'m' is not recognized` under some console codepages.
- **`ezz service status` reported "Service Node: not runnable"** for the very
  `node.exe` the daemon was running from. `run()` goes through PowerShell, where
  a quoted executable path needs the `&` call operator; three version probes
  built the command by hand instead of using `quoteExe()`, the single owner of
  that rule.
- **A paired server flapped "Connected to hub" / "Disconnected" every few
  seconds, indefinitely.** `initHubAgent()` assigned a new socket over the old
  one without disconnecting it, so a second call left two live sockets. The Hub
  keeps one socket per server and evicts the older; the evicted client
  re-dialled and evicted the other, for ever. `initHubAgent()` is now
  idempotent. The second call came from pairing in the dashboard, which started
  an agent even while the daemon owned the jobs: pairing now defers to a running
  daemon, and `saveHubLink()`/`clearHubLink()` bump the revision counter so the
  daemon learns about a pairing change — it previously never did.
  `hub_backend` now logs a reason for every agent disconnect and every refused
  handshake, which is what made this diagnosable.
- **The Windows logon launcher's restart backoff did not wait.** It called
  `timeout` through `PATH`, which on any machine with Git for Windows or GNU
  coreutils resolves to the Unix `timeout` — that rejects `/t`, so the delay was
  skipped and the backoff became the tight restart loop it exists to prevent.
  Measured, not assumed. It now calls `%SystemRoot%\System32\timeout.exe` by
  absolute path, with a `ping` fallback for the logon contexts where
  `timeout.exe` refuses a redirected stdin. Its log-trim guard also used
  `%%~zA` on a file that does not exist on first run, which is a batch syntax
  error; it is now guarded with `if exist`.
- **`install.sh` could install the background service without being asked.** It
  tested `[ -r /dev/tty ]`, which can pass on a process with no controlling
  terminal while the open then fails — leaking `No such device or address` and
  falling through to the default, which is yes. It now opens the terminal once
  on a file descriptor and treats a failed open as unattended, printing the
  command instead.
- **A notification was marked sent before it was sent.**
  `shouldSendNotification()` wrote "notified" to the database and only then did
  the caller try to deliver it, so a webhook that was down meant the state
  already claimed the notification had gone out and it was never retried — the
  user simply never heard about an outage. The order is now
  evaluate → claim → send → commit, and a failed send releases the claim so the
  next poll tries again. `sendNotification()` reports what it managed to
  deliver instead of swallowing every per-channel error; partial delivery
  counts as sent, because re-sending would duplicate on the channels that did
  work. Exactly one process can send a given transition, enforced by an atomic
  `open(path, 'wx')` claim in the data directory — a file rather than a
  database row because `good.db` offers only get/set, with no compare-and-swap,
  and raw SQL is prohibited.
- **The Windows logon launcher's restart backoff did not wait.** It called
  `timeout` through `PATH`, which on any machine with Git for Windows or GNU
  coreutils installed resolves to the Unix `timeout` — that rejects `/t`, so
  the delay was skipped and the backoff became the tight restart loop it exists
  to prevent. Measured, not assumed. It now calls
  `%SystemRoot%\System32\timeout.exe` by absolute path, with a `ping` fallback
  for the logon contexts where `timeout.exe` refuses a redirected stdin. Its
  log-trim guard also used `%%~zA` on a file that does not exist on first run,
  which is a batch syntax error; it is now guarded with `if exist`.
- **`install.sh` could install the service without being asked.** It tested
  `[ -r /dev/tty ]`, which can pass on a process with no controlling terminal
  while the open then fails — leaking `No such device or address` and falling
  through to the default, which is yes. It now opens the terminal once on a
  file descriptor and treats a failed open as "unattended", where it prints the
  command instead.
- **The nginx log page was permanently empty on Linux.** `getLogs()` read
  `<nginxDir>/logs/error.log` unconditionally, which is the Windows layout; a
  distribution nginx logs to `/var/log/nginx`. The live tail had the branch
  right, which is why this showed up as "the tail works but the log page does
  not". There is now one resolver, `nginxLogPath()` in `core/platform.js`, used
  by all three call sites — and `getLogs()` takes an additive `which` argument,
  so the access log is reachable at all.
- **PM2 was resolved to a file Windows cannot execute.** npm's global bin holds
  both a Unix shell script with no extension and a `.cmd` shim, and
  `where.exe pm2` lists the unusable one first. That produced "PM2 installed,
  version null" and an unparseable process list. The resolver now prefers an
  extension Windows can run.
- **The PM2 process list was parsed from the wrong bracket.** `pm2 jlist`
  prints `[PM2]`-prefixed notices around its JSON, and taking the first `[`
  returned the string `"[PM2]"` instead of the array. Candidates are now
  validated by parsing, so the notices are skipped.
- **`PM2_HOME` does not isolate PM2 on Windows.** Its daemon is reached over
  named pipes whose names are fixed, not derived from `PM2_HOME`, so every
  invocation on the machine talks to the same daemon and the same process list.
  Measured directly: an app started with `PM2_HOME` pointed at a temporary
  directory is listed by `pm2 jlist` with no `PM2_HOME` set. The service test
  suite therefore drives a stub `pm2` executable and asserts, before every
  command, that the pm2 being invoked is that stub — the guard is on the
  command, not on an environment variable that turned out not to be
  load-bearing. Documented in STRUCTURE.md.

#### Hub permission tree
- Permissions are now a catalog of groups and children in `src/core/hubPermissions.js`, replacing the
  three coarse toggles. Nginx (start, stop, restart, reload, test, view configs, edit configs, view
  logs), Domains (create, edit, toggle, delete), SSL (renew, renew all, issue, delete), plus a System
  group reserved for later.
- Enabling a group enables its children; a partly-enabled group shows as indeterminate. Capabilities
  that are not implemented yet appear in the tree with a **Coming soon** badge and cannot be enabled.
- **Monitoring is not a permission.** Metrics, nginx status, the domain list, health and certificate
  expiry are always reported — gating read-only telemetry would make the Hub useless without
  protecting anything.
- Existing links migrate once, idempotently, preserving exactly what the Hub could already do:
  `reloadNginx` → the five nginx service actions, `manageDomains` → all `domains.*`, `manageSSL` →
  `ssl.renew` and `ssl.renewAll` only. `nginx.config.view` and `nginx.logs.view` were never gated
  before, so they are granted to existing links rather than silently taken away. New capabilities
  (`ssl.issue`, `ssl.delete`, `nginx.config.edit`) stay off.
- The agent re-checks every command against the catalog locally. That remains the real security gate;
  the Hub's copy is only a UI hint.

#### New Hub capabilities
- **`nginx.config.edit`** — edit a config file from the Hub. Goes through the same
  write → `isNginxTestOk()` → reload path as everything else, with an exact rollback when nginx
  rejects the result, and only for files inside the nginx config directory.
- **`ssl.issue`** — issue a new certificate over HTTP-01 without stopping nginx. Wildcards stay
  **coming soon**: DNS-01 needs a TXT record added by hand.
- **`ssl.delete`** — refuses while an enabled domain still uses the certificate, naming the domains,
  since deleting it would leave nginx pointing at a missing file.

#### Real-time sync
- **Permissions → Hub:** pushed the moment they change and on connect, so the Hub UI greys out
  actions immediately.
- **Hub → local dashboard:** after the agent applies a command, open browser tabs refresh just the
  affected section instead of showing stale data.
- **Dashboard or CLI → Hub:** a revision counter in SQLite, bumped by `saveDomains()` and by every
  certificate change. The agent polls it every 3 seconds and pushes only when it moves. The CLI runs
  in a separate process from the agent, so an in-process event cannot reach it; a small integer read
  is the cheapest shared signal, and it replaces a five-minute heartbeat.
- **Command acknowledgement:** every command carries a `requestId` and the agent replies
  `command:result { requestId, ok, error, data }`, relayed to the browser. SSL results include
  `mode`, `fellBack`, `nginxDownMs` and `summary`. Timeouts are 30s normally and 180s for SSL issue
  and renew, after which the UI reports no response. This replaces a blind `setTimeout(refresh, 3000)`.

### Changed

- **Sudoers rules are narrower.** The bare `/usr/bin/systemctl` grant is gone — it allowed every
  systemctl verb against every unit, enough to disable unrelated services. The `certbot`, `cp` and
  `chmod` grants are gone too (SSL is issued in-process by `acme-client`; no binary is invoked).
  **Re-run `Settings → Linux Permissions` on each server to apply the tighter rules.**
- Hub: `POST /servers/:id/command` now returns **403** when the server has that permission disabled,
  instead of reporting `200 dispatched` for a command the agent would silently drop.
- Hub: server names are capped at 100 characters (trimmed), and the JSON body limit is 256 kB (was
  10 MB).
- Hub UI: action buttons tied to a permission are **disabled, not hidden**, with a tooltip on hover
  and keyboard focus saying which permission to enable and where. The server page shows a read-only
  permission tree — permissions are only changed from the server's own dashboard, by design.
- `useServerSocket` handles the `subscribe:server` acknowledgement and surfaces a refused join
  instead of showing a page that never updates.
- `e2e/pairing-smoke.test.mjs` allocates random free ports and keeps the port guard only as a last
  safety net, so it can never drive a running stack.


### Changed

#### Tests cannot reach real data any more

Five separate incidents ended with an e2e suite reading or writing the real
`%APPDATA%\easy-devops` / `~/.config/easy-devops`. Every one had the same root
cause: `core/db.js` resolves its data directory **once, at module load**, and
ESM evaluates a file's entire static import graph before the first line of that
file runs. Setting `EASY_DEVOPS_DATA_DIR` at the top of a suite is therefore
already too late, and no amount of care inside the test files fixes that
ordering. So the fix is structural, in three layers:

- **`core/platform.js getDataDir()` refuses.** With `EZ_TEST=1`, resolving the
  real data directory **throws** instead of returning it: no override set, or
  one that is the real directory, inside it, or a parent of it. A directory
  under the system temp folder is accepted as throwaway — needed, because
  several suites isolate themselves by redirecting `APPDATA`/`HOME` into their
  temp directory, which makes the "real" path land inside that same directory.
- **`e2e/run.mjs` is the only sanctioned way to run the suites.** It creates a
  fresh temporary data directory per suite and runs each one as a **child
  process** with `EZ_TEST=1` and `EASY_DEVOPS_DATA_DIR` already in its
  environment — the only point at which the variables are certainly in force
  before any import is evaluated. Suites that spawn their own children now pass
  both through explicitly rather than relying on inheritance.
- **A static-import check runs before any suite.** It fails if a suite's first
  static import is not `e2e/lib/guard.mjs`, or if any static import reaches
  `src/` — either of which would let code run before the guard. Core modules
  must be loaded with a dynamic `await import()` inside the suite.
  `npm run test:e2e:check` runs it alone.

Running a suite directly now fails immediately with instructions instead of
quietly operating on the real installation.

```
npm test                        all suites
npm run test:e2e -- service     one suite
npm run test:e2e:check          the static-import check only
```

### Added

#### "No password" is now an explicit, bounded option

An empty password used to mean "no login", which was indistinguishable from a
misconfiguration — so the previous release refused it outright. That was right
for an exposed dashboard and wrong for a single-user machine, where running
without a password is a reasonable choice. It is now a setting rather than an
accident.

- **`dashboardAuth`**: `"password"` (default) or `"none"`.
- **`"none"` requires a loopback bind.** The API refuses to switch to it while
  `dashboardBindAddress` is reachable from the network, and refuses to move the
  bind off loopback while it is in force — telling the user to set a password
  first. Both halves are validated against the state the request would
  *produce*, so one request cannot set both and slip past a check made against
  the old value. Turning auth off also has to come from the machine itself.
  `effectiveAuthMode()` re-checks at request time, so a hand-edited or restored
  config claiming `none` with a public bind still requires a password.
- **First-run screen** offers "Set a password" or "No password (this machine
  only)". The second appears only when the request came from loopback *and* the
  bind is loopback — elsewhere it is not rendered at all.
- **Configurable from Settings and from `ezz settings`**, both of which enforce
  the same interlock. The CLI's password field also now hashes properly; it was
  still writing plain text, which the dashboard stopped doing last release.
- **Existing installs**: an empty password with a loopback bind becomes an
  explicit `none` and keeps working. An empty password with a bind reachable
  from the network — including an install that predates the bind setting, which
  migrates to `0.0.0.0` — must set a password.

#### Protection against other websites in the same browser

A session cookie, or no login at all, protects nothing from a page the user has
open in another tab. Two attacks are now refused, **in both auth modes**:

- **DNS rebinding.** A hostile domain resolving to 127.0.0.1 reaches the
  dashboard with its own hostname in `Host`. On a loopback-bound dashboard the
  `Host` hostname must be `localhost`, `127.0.0.1` or `[::1]`, and the port
  must match.
- **Cross-site request forgery.** `Origin`, when present, must be loopback with
  the dashboard's port; and every `POST`/`PUT`/`PATCH`/`DELETE`, plus the
  Socket.io handshake, must carry **`X-EZ-Request: 1`**. A cross-site form
  cannot set a custom header, and a cross-site fetch that tries triggers a CORS
  preflight the dashboard never approves.

These return **403**, not 401: a login cannot fix "this request may not be made
from where it came from", so the UI must not be sent to the login screen.

**On a non-loopback bind the `Host` rule relaxes to same-origin** — `Origin`
must match `Host` — rather than demanding a loopback name. Enforcing loopback
there would make a dashboard that was deliberately bound to all interfaces
unreachable, which would have silently removed the feature added last release.
The `X-EZ-Request` requirement is unconditional.

The browser client must not force `transports: ['websocket']`: browsers cannot
set headers on a WebSocket upgrade, so socket.io's default polling-first order
is what lets the handshake carry the header.

### Changed

- **Constitution amended to 2.0.0** (`.specify/memory/constitution.md`). MAJOR,
  per its own Governance rules, because two existing rules are incompatibly
  redefined: Principle III ("No Build Step", frontend from a CDN) now permits a
  dashboard UI build step while *prohibiting* runtime CDN loading, and the
  Development Workflow's "no test suite … do not add a test framework" is
  replaced by required plain-Node e2e suites with `npm test` passing before
  release. Two principles were added: **VII. Test Isolation** (enforced in code,
  not convention) and **VIII. Simplicity and Zero Configuration** (measured by
  the time from install to a first domain on HTTPS).
- **`CLAUDE.md` now carries the hard rules** as a 27-point summary, because
  spec-kit is no longer used day to day and the constitution was not being read.
  The two must be updated together.

### Documentation

- **New `docs/api-contract.md`** (contract v1.0.0), written from the current
  code: every dashboard REST endpoint with method, path, auth, request and
  response shapes and error codes; every Socket.io event in both directions with
  payload, emitter, and whether it belongs in the background daemon when that is
  split out; and the transport rules above.
- **The e2e runner now enforces it.** It reads the mount prefixes from
  `server.js` and the paths from each router's own Express stack — not a regex,
  which cannot see a route added through a helper or a nested router — and fails
  the run on any mismatch in either direction. Verified by adding an
  undocumented route and by removing a documented one. 48 routes currently
  documented.

### Security

#### The dashboard API now requires a session

**Every API route is authenticated.** `/api/domains`, `/api/ssl`, `/api/nginx`
and `/api/settings` had no session check at all: anything that could reach the
dashboard port could list and delete domains, rewrite nginx configs, read the
backup and change settings. Only `/api/hub` and `/api/processes` were
protected. Now a single `requireAuth` (`src/dashboard/lib/requireAuth.js`)
guards every router, and the two private copies of that check have been
replaced by it. The only public endpoints are the session check, login, logout
and first-run setup.

This was urgent because of the previous release: the dashboard can now run 24/7
as a background service, so an unprotected endpoint is not "exposed while I
have a terminal open" — it is exposed on every boot.

**Socket.io is authenticated too.** The dashboard's socket streams nginx
status, domain health and live log tails — the same data the HTTP routes are
protected for — and accepted any connection. It now runs the same
express-session middleware on the handshake and refuses a connection without a
logged-in session.

**An empty password is no longer a valid login.** The check was
`password === dashboardPassword`; with no password configured, both sides were
empty and submitting a blank form signed you in. An unset password is now
refused outright, and the login page instead asks you to set one (at least 8
characters) before anything else works.

**Passwords are stored hashed.** `core/passwords.js` uses `crypto.scrypt` with
a random 16-byte salt per password and compares with `timingSafeEqual`; no new
dependency. The cost parameters travel with the hash, so they can be raised
later without invalidating stored passwords. An existing plain-text password
keeps working and is migrated to a hash on the next successful login, after
which the plain-text copy is cleared.

**Login is rate limited** to 10 attempts per 15 minutes per IP, in memory
(`src/dashboard/lib/loginRateLimit.js`), returning 429 with `Retry-After`. The
counter is cleared on a successful login. Attempts are counted before the
password is examined, so guessing against an unset password costs the same as
guessing against a real one.

**Sessions are regenerated on login and on setup**, so a session id planted
before sign-in cannot become an authenticated one.

**Neither the password nor its hash ever leaves the server.** `GET /api/settings`
never returned the password and now also omits the hash, and `GET /api/settings/backup`
strips both — a downloaded backup is a file people share, and a scrypt hash is
still worth cracking offline. Restoring a backup can no longer reinstate a
plain-text password or change the bind address.

#### Bind the dashboard to localhost

New setting `dashboardBindAddress`, shown and changeable in Settings → General,
with the current value and whether it is reachable from the network. **New
Linux installs default to `127.0.0.1`**; Windows installs default to
`0.0.0.0`, because a Windows box is usually a workstation behind a firewall and
binding to loopback would break the common "reach it from my laptop" setup.

**Existing installs are unaffected.** A config written before this release has
no bind address, and is explicitly kept on `0.0.0.0` rather than inheriting the
new default — an upgrade must not silently cut off a dashboard someone reaches
over the network. The choice is then theirs to make in Settings.

#### Frontend

The page returns to the login screen on any 401, with "Your session ended" —
rather than leaving a half-dead dashboard showing stale data — and the first
run shows a set-a-password form instead of the old "No password set? Leave
blank and press Sign In" hint.

#### Tests

New `e2e/dashboard-auth.test.mjs`: 87 checks over a dashboard on a random port
with a temporary data directory, asserting that **29 endpoints across all six
routers return 401 without a session**, that the same endpoints work with one,
that an anonymous Socket.io connection is refused and an authenticated one is
not, the first-run flow and its minimum length, rate limiting (including that a
correct password is still refused while limited), scrypt storage, plain-text
migration, and the upgrade-safe bind address.

### Fixed

#### Domains now stay in sync with the Hub
Three independent faults meant the Hub's domain list drifted away from the server's: a delete never
arrived, a change made by the CLI never arrived, and nothing at all reached an open browser.

- **Deletes reach the Hub, and ghost domains disappear.** The agent always sent its *complete*
  domain list, but `hub_backend` merged it row by row with an upsert, so a name that stopped being
  mentioned was simply left behind — for ever. `domain:configs` is now an atomic replace: one
  transaction adds, updates and deletes so the Hub's set matches the server's exactly. Renames work
  for the same reason (the old name is no longer kept alongside the new one). Because the agent
  re-sends the full list on every connect, **an existing ghost domain is cleaned up as soon as the
  server reconnects** — no manual step.
- **A second source of ghosts is gone.** `cert:expiry` also upserted, so every certificate found on
  disk created a domain row — including certificates for names that are not configured domains. It
  now only updates domains that already exist; `domain:configs` is the only writer that may create
  or remove them.
- **Changes made in another process (the CLI) reach the Hub.** `good.db`'s read cache is a plain
  in-process LRU with no TTL and no cross-connection invalidation: the first `get` of a key was
  returned for the life of the process. Easy DevOps runs the CLI and the dashboard as separate
  processes against one database, so the agent's revision poll kept reading the counter it saw at
  startup and never noticed the CLI moving it. The cache is now off in `src/core/db.js` — measured
  cost is ~50us for a scalar key and ~150us for the whole domain list, which is nothing at this
  app's read rates, and correctness no longer depends on each call site remembering to ask for a
  fresh read.
- **The Hub UI updates live.** After the replace, `hub_backend` emits `server:<id>:domains` with the
  new set to that server's browser room, and `useServerSocket` exposes it, so the domains section
  reflects adds, edits, toggles and deletes — whoever made them — without a reload or a poll.
- **Restoring a backup bumps the revision.** `settingsController.restore()` wrote the domain list
  with a bare `dbSet`, bypassing `saveDomains()`, so a restore left the Hub showing the pre-restore
  list until the next restart. It goes through `saveDomains()` now, which remains the one chokepoint
  every domain write uses.
- The agent clears its last-pushed revision on every (re)connect, so a reconnect always re-pushes
  even when the counter has not moved — for instance after the Hub itself is restarted.
- **The active data directory is now visible**, in the dashboard's Settings → Hub card and on the CLI
  banner, with a loud warning when it is a `--dev` / `EASY_DEVOPS_DATA_DIR` override. A CLI and a
  dashboard on different data directories edit two different domain lists, which looks exactly like
  broken synchronisation.
- New `e2e/domain-sync.test.mjs` drives the whole scenario end to end — dashboard API, a separate
  CLI-style process and Hub commands, each for create/edit/toggle/delete — and requires every one to
  reach both the Hub database and a subscribed browser socket within 5 seconds, plus a pre-seeded
  ghost that must disappear after a reconnect. It fails 14 checks against the unfixed code.
- Fixed a stale assertion in `e2e/pairing-smoke.test.mjs` that still read the pre-permission-tree
  `permissions.reloadNginx`, which no longer exists, so the check passed vacuously.

#### Certificates are issued and renewed without stopping nginx
- **nginx now stays up for the whole issuance.** Every generated port-80 server block forwards
  `/.well-known/acme-challenge/` to a temporary loopback listener that Easy DevOps starts for the
  duration of the challenge, and only a graceful reload is used afterwards.
- **Why renewals used to leave nginx down.** `stopNginx()`/`startNginx()` in the SSL manager ran bare
  `systemctl stop|start nginx` — no `sudo -n`, so they silently failed for a non-root user — and on
  Windows the start command ran `nginx.exe` with no working directory, which fails on
  `logs/error.log` and never comes back. There was also no `finally`, so any error between stop and
  start left nginx stopped, and `listen(80, cb)` mis-handled bind errors as an unhandled `'error'`
  event. All four are fixed.
- **The HTTP→HTTPS redirect no longer swallows the challenge.** nginx executes a server-level
  `return` during the rewrite phase, *before* location matching, so the old redirect blocks would
  have answered the challenge with a 301 no matter what location was added. The redirect now lives
  in `location /`, and the challenge in `location ^~ /.well-known/acme-challenge/`. Verified against
  a real nginx: the old shape returns 301, the new one returns the token.
- **A domain with SSL on and the redirect off now still gets a port-80 block** (challenge only,
  everything else 404). Previously such a domain had no port-80 listener at all, so an HTTP-01
  renewal could never reach us.

#### Two-mode issuance with a local preflight
- `sslChallengeMode` (`auto` by default, or `proxy` / `standalone`). In `auto`, a **local** preflight
  serves a throwaway token and fetches it back through nginx before Let's Encrypt is contacted. Only
  a failed preflight may trigger the standalone fallback — never a Let's Encrypt failure — so a
  misconfiguration cannot burn rate limits.
- The preflight probes the address nginx actually listens on: a config that binds
  `listen 203.0.113.5:80` is not reachable on loopback, and the error now says which addresses were
  tried and what each returned instead of silently falling back.
- Standalone mode restores nginx in a `finally` block, verifies it is running, retries once, and
  reports an explicit error if it does not come back.
- When both modes fail the error states that the cause is likely outside Easy DevOps (DNS, a
  firewall on port 80, an AAAA/IPv6 record, or a CDN forcing HTTPS) and includes what the preflight
  saw.
- The CLI, the dashboard response and the Hub command result all report which mode ran, whether the
  fallback was used, and how long nginx was stopped.

#### Other
- New `src/core/ssl-issuer.js` is the single implementation used by the CLI, the dashboard API and
  the Hub command path; `ssl-manager.js`'s `issueCert`/`renewCert` are now thin wrappers, removing
  the duplicated challenge logic.
- New `src/core/acme-challenge.js` holds the challenge listener. It is reference counted and
  serialized, so two issuances running at once share one listener safely and the last one out closes
  it. A busy port fails with a clear message instead of a confusing bind error.
- Renewing a domain whose config predates this feature regenerates that config first (through
  `writeConfWithTest`, so a bad config rolls back) and reports that it did so. Adding a new domain
  with SSL writes an HTTP-only config first, since a 443 block referencing a certificate that does
  not exist yet fails `nginx -t`.
- New config options: `acmeChallengePort` (default 8089) and `acmeStaging`. **Staging is used
  automatically in dev data mode**, so development can never consume production rate limits.
- nginx start/stop/reload commands are now built in `core/platform.js` and match the sudoers rules
  written by `core/permissions.js` byte for byte. Windows start reuses the proven detached
  `Start-Process … -WorkingDirectory` form from `dashboard/lib/nginx-service.js`.
- Wildcard certificates still use DNS-01 and never touch nginx.

### Added

#### Dev data mode (`--dev` / `npm run dev`)
- `EASY_DEVOPS_DATA_DIR` redirects **all** persistent data — the SQLite database, dashboard sessions
  and the dashboard log — to a chosen directory. `--dev` points it at `.dev-data/` in the project,
  so development never touches your installed configuration. Child processes (the detached
  dashboard) inherit it automatically.
- **The legacy data migration never runs in dev mode.** That migration *renames*
  `data/easy-devops.sqlite`, so without this guard a single `npm run dev` would have consumed the
  real installation's database.
- `DEV MODE (data: …)` is shown in the CLI banner and the dashboard startup log.
- New `npm run dev` script; `npm start` is unchanged. `.dev-data/` is git-ignored.

#### `--dash` shortcut
- `ezz --dash` (or `easy-devops --dash`) starts the dashboard in the foreground, prints its URL, and
  stops cleanly on Ctrl+C — closing the HTTP server, the Socket.io server, every log tail, all
  polling intervals, the hub agent and the SQLite handle. Combines with `--dev`.
- `shutdown()` is idempotent: a second Ctrl+C during shutdown neither throws nor double-closes. A
  5-second watchdog forces an exit if a socket refuses to close.
- New `--help` / `-h` (documenting `--dash`, `--dev`, `system-info`) and `--version` / `-v`.

### Fixed

- **`ezz --dash` could not exit on Ctrl+C.** Two module-level timers kept the event loop alive with
  no way to stop them: the three Socket.io polling intervals in `socketManager.js` (now cleared by a
  new `stopSocket()`, which also kills active log tails) and the DNS-challenge sweep in
  `sslController.js` (now cleared by a new `stopSslController()`, which also rejects anything still
  pending). This also means a stopped dashboard no longer leaves orphaned `tail` / `Get-Content`
  child processes behind.
- **The dashboard log no longer lives inside the package.** `data/dashboard.log` moved to
  `<data dir>/logs/dashboard.log` — a package-relative path violates Principle IV and is wiped by
  `npm update`.
- The data directory is now resolved in exactly one place, `getDataDir()` in `src/core/platform.js`.
  This removes the last two `process.platform` checks outside that module (`core/db.js` and
  `dashboard/server.js`), which had duplicated the same OS branch.

#### Windows: SSL certificate paths in generated nginx configs
- **Certificate paths are now written with forward slashes on Windows.** nginx's config lexer
  expands `\n`, `\r` and `\t` as escape sequences, so an unquoted path such as
  `C:\nginx\test\certs\fullchain.pem` was read as `C:` followed by a newline and a tab. This is why
  the same config was accepted on one machine and rejected on another — it depended entirely on
  whether a folder name began with `n`, `r` or `t`. Verified against nginx on Windows: the
  backslash form fails with `cannot load certificate "C:` (truncated at the newline), the
  forward-slash form passes.
- Quoting alone does **not** help — `"C:\nginx\test\..."` fails identically. Only forward slashes,
  or doubled backslashes inside quotes, survive the lexer.
- Path normalisation now happens in one place: `toNginxPath()` / `toEscapedNginxPath()` in
  `src/core/platform.js`. **Linux output is byte-for-byte unchanged** — both helpers are identity
  functions there, and no comment is added.
- New `src/core/nginx-apply.js` with `writeConfWithTest()`: writes the config, tests it via
  `isNginxTestOk()`, and on Windows retries once with quoted escaped-backslash paths **only when
  nginx blames this config file's certificate directives**. A certificate error in a different
  config never triggers a rewrite here. If every attempt fails the previous file content is
  restored byte-for-byte (or the file removed if it was new), and the error names the file nginx
  complained about.
- A comment is written above the SSL directives recording which path form was used.
- The CLI, the dashboard API and the Hub `manageDomain` path now all share this one function,
  replacing three separate copies of the write/test/rollback logic (and the `.bak` file juggling
  that went with them).
- `getDefaultCertPaths()` now honours the configured `sslDir` instead of always suggesting
  `C:\easy-devops\ssl`. The Windows default is unchanged (`C:\easy-devops\ssl`), so this only
  affects installs with a customised `sslDir` — where the old value pointed at a directory
  certificates were never issued into. The same fix was applied to the equivalent hardcoded paths
  in the CLI domain wizard and the dashboard's cert-path autofill.
- Existing configs are **not** rewritten automatically. Domains whose stored certificate paths
  still contain backslashes are reported — as `sslPathWarning` on `GET /api/domains` and as a
  notice in the CLI domain list. Editing and saving such a domain regenerates it through the
  shared apply path, which fixes it.

- **The agent no longer goes silent after the Hub rotates its secret.** When the Hub closes the
  connection deliberately (which is what a secret rotation does), Socket.io does not reconnect on
  its own, so the agent sat in `connecting` forever and never reported what had happened. It now
  re-dials on its own capped backoff, so the next handshake surfaces the real state — normally
  `rejected`, telling the user to paste the new connection string.
- **`Settings → Hub` no longer stays stuck on "Hub unreachable".** The status poll stopped as soon
  as the state became `unreachable`, so a hub that came back was not reflected until the page was
  revisited. The tab now keeps polling (every 15s) while unreachable, and stops only on states that
  need the user: `connected`, `rejected`, `not_linked`.
- **`Settings → Hub` buttons no longer latch disabled.** A failed `fetch` left `hub.loading` true,
  permanently disabling Connect and Unlink with no message shown.
- The hub status poll timer is now cleared when navigating away from Settings.
- `hubAgent` reload now reuses the dashboard's own nginx reload path instead of rebuilding the
  command, so it resolves the nginx executable on Windows and uses the `sudo -n` form the sudoers
  rule actually grants on Linux.
- Connection-string validation now caps the input length and rejects non-URL-safe server IDs and
  secrets, non-http(s) hub URL schemes, and hub URLs carrying embedded credentials.

### Changed

#### Hub pairing is now hub-first
- **The Hub issues connection strings; the server no longer generates them.** Previously the
  dashboard minted a `serverId` + secret, started connecting immediately, and left the agent looping
  on "Reconnecting" until the user pasted the string into the Hub. Now you add the server in the Hub,
  copy the string it returns once, and paste it here — nothing connects until a valid string is saved.
- `Settings → Hub` replaces the "Hub URL + Generate Connection String" flow with a single paste field
  and a **Connect** button. Unlink and the three permission toggles are unchanged.
- `POST /api/hub/generate-link` is **removed**. `POST /api/hub/connect` now takes
  `{ connectionString }`, validates it, saves the link, and then starts the agent.
- Re-pairing preserves existing permission grants — rotating a secret no longer silently resets what
  the Hub is allowed to do.

### Added

#### Agent connection statuses
- The agent now distinguishes **authentication rejection** from **network failure**. A hub that
  refuses our credentials (`AUTH_REQUIRED`, `UNKNOWN_SERVER`, `INVALID_SECRET` — including when the
  server was deleted from the Hub) stops the retry loop instead of reconnecting forever.
- `GET /api/hub/status` exposes `status`, `lastError`, and `attempts` alongside the existing
  `linked` / `connected` fields. Statuses: `not_linked`, `connecting`, `connected`, `rejected`,
  `unreachable`. The Hub tab shows the status with an explanation of why it is not connected, and
  offers a paste field inline when the state is `rejected`.
- Network retries back off from 1s to a 60s cap (was 30s).

#### `src/core/hubLink.js`
- New core module owning the whole hub-link lifecycle: parsing and validating the `ezops://`
  connection string, reading / saving / clearing the link, the permission flags, and the
  classification of handshake failures. The dashboard controller and the agent both consume it, so a
  future CLI menu can reuse the same logic. Adds `validateConnectionString` and `validateHubUrl` to
  `src/core/validators.js`.

### Compatibility

- **Servers already linked keep working with no action required.** The stored `hub-link` and
  `hub-permissions` shapes are unchanged; only the way a link is first established has changed.

---

## [1.2.0] — 2026-04-10

### Added

#### Notification Channel Registry
- New **named channel system** — Discord webhooks and Telegram bots are registered once in Settings → Notifications with a name and UUID. Channels are stored in SQLite under `notification_channels` and reused across any number of domains and event types.
- **Settings → Notifications tab** — settings page split into General and Notifications tabs. The Notifications tab lists all configured channels with Test / Edit / Delete actions per row.
- **Channel CRUD API** — five new endpoints under `/api/settings/channels`:
  - `GET` list all channels
  - `POST` create a channel (generates UUID, validates type-specific fields)
  - `PUT /:id` update name or credentials (type is immutable after creation)
  - `DELETE /:id` remove a channel
  - `POST /:id/test` send a live test notification to a single channel
- **Discord message prefix** — optional "Message Prefix" field on Discord channels. Value is sent as the `content` field of the webhook (not inside the embed), so role mentions like `<@&RoleId>` are resolved by Discord correctly.

#### Per-Domain Notification Config
- Domain edit form gains a **Notifications accordion** section showing two event types: `cert_expiry` (SSL certificate expiry) and `domain_health` (backend port check). Each event has an enable toggle and a channel checkbox list.
- `nginx_down` is intentionally absent from per-domain config — it is a global event and is routed using the union of all configured channel IDs across all domains.
- Per-domain config stored in SQLite under `domain_notification_config`. Default is enabled with no external channels (dashboard-only).
- API: `GET /api/domains/:name/notifications` and `PUT /api/domains/:name/notifications`.
- Domain list and create/update responses now include a `notifications` field.

#### Notification State Tracking (deduplication + recovery)
- `shouldSendNotification(domain, eventType, currentStatus)` in `core/domainNotifier.js` implements a state machine that prevents repeated alerts for the same condition.
- **First check**: records baseline state, sends no notification.
- **Down**: sends alert only on the `up → down` transition.
- **Still down**: no repeated notification.
- **Recovery**: sends a "back online" notification on the `down → up` transition.
- State persisted in SQLite under `notification_state` — survives server restarts.

#### Recovery Notifications
- `createNginxRecoveredEvent()` in `core/events.js` — `severity: 'success'`, used when nginx comes back up.
- `createDomainDownEvent(domain, port)` and `createDomainRecoveredEvent(domain, port)` — carry the backend port in the message for clarity.
- Both Discord and Telegram render recovery events with distinct messaging from down events.

#### Dashboard Notifications Panel (base)
- Bell icon in the navbar with an unread badge counter.
- Socket.io `notification:new` events for: nginx status, SSL cert expiry (within 30 days), domain health.
- Sliding notification panel with severity colouring and timestamps. "Clear all" button. Badge resets when the panel is opened.
- Deduplication by event `id` — replacing the same event in place instead of appending duplicates.

#### Nginx Log Viewer (`Logs` page)
- New sidebar page. Streams `tail -f` over Socket.io for `error.log` and `access.log`.
- Toggle between logs with a button group; auto-scroll to newest line; Pause/Resume.
- Colour-coded output: red for `[error]`/`[crit]`, yellow for `[warn]`, green for 2xx/304.
- Max 500 lines buffered; cleared on log switch.

#### Domain Health Check Badges
- Server polls each domain's `backendHost:port` via HTTP HEAD every 60 seconds.
- Live green `● Up` / red `● Down` badges in the domains table.
- External URL backends (starting with `http`) are skipped.
- Health check failures emit `notification:new` to the browser panel and dispatch to configured external channels.

#### Backup & Restore
- **Export**: `GET /api/settings/backup` — downloads config and domains as JSON. Dashboard password excluded.
- **Import**: `POST /api/settings/restore` — restores config and domains from a backup file. Confirmed via SweetAlert2 dialog.

### Changed

- **`core/events.js`** — added `createNginxRecoveredEvent()`, `createDomainDownEvent(domain, port)`, `createDomainRecoveredEvent(domain, port)`. Existing `createDomainHealthEvent` kept as a legacy wrapper. All event IDs are now unique per emission (timestamp suffix) to prevent false deduplication.
- **`socketManager.js`** — nginx and domain health handlers rewritten to use `shouldSendNotification()` for state-aware dispatch. `getAllDomainChannelIds(eventType)` used for global events (nginx_down) instead of a null-domain lookup that always returned empty.
- **`core/notifier.js`** — rewritten to the named-channel model. `sendNotification(event, channelIds)` resolves each UUID to a channel object and dispatches to the matching `channels/{type}.js` module. Empty or null `channelIds` is a no-op (dashboard-only path).
- **`core/domainNotifier.js`** — replaced type-name arrays with UUID arrays (`channelIds`). Added `getAllDomainChannelIds(eventType)` (union across all domains) and `shouldSendNotification` state machine.
- **Discord channel** — message prefix routed to webhook `content` field instead of embed description, enabling Discord mention resolution.
- **Routes refactored into controllers** — `dashboard/routes/domains.js` and `dashboard/routes/settings.js` extracted into `dashboard/controllers/domainsController.js` and `dashboard/controllers/settingsController.js`.
- **Settings page** — split into "General Settings" and "Notifications" tabs via `settingsTab` state.

### Security

- **Random session secret** — generated once via `crypto.randomBytes(32)`, stored in SQLite `session_secret` key.
- **Request body size limit** — `express.json({ limit: '1mb' })`.
- **Login rate limiting** — `express-rate-limit` on `POST /login`: max 10 attempts per 15 minutes.

### Fixed

- **Domain health notifications never fired** — `emitDomainHealth` only emitted the `domain:health` socket event for UI badges; it never called `sendNotification` or emitted `notification:new`. Both are now called for every down domain.
- **nginx_down never reached external channels** — `getEffectiveChannelIds(null, 'nginx_down')` always returned `[]` because a `null` domain falls back to defaults which have empty `channelIds`. Replaced with `getAllDomainChannelIds('nginx_down')` which unions channel IDs from all domain configs.
- **CLI detection spam** — `runDetection()` now caches results for 60 seconds. Subprocesses (`nginx -v`, `npm --version`, etc.) no longer run on every main menu return.
- **Sessions survive restarts** — `session-file-store` persists sessions to disk.
- **Vue data() return object truncated** — a duplicate closing brace in `app.js` caused `permissions`, `backup`, `channels`, `channelModal`, and `notifications` to be declared outside the `data()` return object, making them non-reactive. Fixed by removing the extra brace.

---

## [1.1.0] — 2026-04-06

### Fixed

#### Database no longer wiped on npm update
- **Root cause:** `data/easy-devops.sqlite` was stored inside the npm package directory (`src/core/../../data/`). When running `npm install -g easy-devops` to update, npm replaces the entire package folder, deleting the database and all user configuration (domains, passwords, paths, ACME email).
- **Fix:** The database is now stored in a persistent user-level directory that npm never touches:
  - **Linux/macOS:** `~/.config/easy-devops/easy-devops.sqlite`
  - **Windows:** `%APPDATA%\easy-devops\easy-devops.sqlite`
- **Migration:** On first run after updating, Easy DevOps automatically detects an existing database at the old package-relative location and copies it to the new path. The old file is renamed to `easy-devops.sqlite.migrated` so the migration only runs once. No manual action required.

### Changed

- `core/db.js` — `DATA_DIR` now resolves to the user home config directory instead of the package-relative `data/` folder. `os` module imported for cross-platform home directory detection.

---

## [1.0.2] — 2026-04-05

### Fixed

#### nginx -t no longer needs sudo (and never did)
- **Root cause:** `nginx -t` only reads world-readable config files (`/etc/nginx/nginx.conf` is 644). It was never necessary to run it with `sudo`. All sudo prefixes have been removed from every `nginx -t` call across `cli/managers/nginx-manager.js`, `cli/managers/domain-manager.js`, `dashboard/routes/domains.js`, and `dashboard/lib/nginx-service.js`.
- **Why it was breaking:** The dashboard runs headless (no TTY), so `sudo nginx -t` triggered "a terminal is required to read the password" → the test was always reported as failed even with valid configs.

#### nginx -t PID file false-negative (`/run/nginx.pid` Permission Denied)
- **Root cause:** When run as a non-root user, `nginx -t` writes "syntax is ok" to stderr then attempts to write `/run/nginx.pid` — which requires root. This causes nginx to exit with code 1 even though the config is perfectly valid.
- **Fix:** `isNginxTestOk(result)` added to `core/platform.js`. Returns `true` if `result.success` OR if the output contains `"syntax is ok"`. All 11 nginx config-test result checks now use this function instead of checking exit code directly.
- **Tip:** Always use `isNginxTestOk(result)` — never rely on `result.success` alone when checking `nginx -t` results on Linux.

#### sudo -n for all systemctl calls in the dashboard
- The dashboard API runs as a background Express server with no attached terminal. All `sudo systemctl` calls in `dashboard/lib/nginx-service.js` now use `sudo -n` (non-interactive). If NOPASSWD is not configured, the call fails immediately with a clear message instead of hanging.
- `isSudoPermissionError()` updated to catch `"sudo:"` prefix in output (covers `sudo: a password is required`, `sudo: a terminal is required`, and other sudo error variants).

#### Linux permissions setup in Settings
- **Problem:** On Linux, `sudo -n systemctl start/stop/reload/restart nginx` always fails until NOPASSWD sudoers rules are configured. Previously there was no way to configure this from the app.
- **Fix:** New one-time setup flow:
  - CLI: `Settings → Setup Linux Permissions` — uses `runInteractive('sudo -v')` to authenticate, then writes `/etc/sudoers.d/easy-devops` with `NOPASSWD` rules for systemctl and the detected nginx binary path.
  - Dashboard: `Settings → Linux Permissions card` — password field + "Setup Permissions" button. Uses `POST /api/settings/permissions/setup` which pipes the password to `sudo -S` via `spawn` stdin (no terminal needed).
  - New `core/permissions.js` module: `setupLinuxPermissions()`, `checkPermissionsConfigured()`.
  - Status badge shows "✓ Configured" or "⚠ Required". CLI menu shows "✅ configured" or "⚠ required" in the menu item label.

#### Dynamic nginx binary path detection
- `which nginx` is called via `findNginxPath()` in both `core/permissions.js` and `dashboard/lib/nginx-service.js` to detect the real nginx binary path at runtime.
- The SUDO_RULES written to `/etc/sudoers.d/easy-devops` include the detected path (e.g. `/usr/sbin/nginx`) rather than hard-coding `/usr/bin/nginx`.
- Dashboard nginx test/start/save-config flows use the detected path for `nginx -t`.

#### ssl-manager.js mkdir under /etc/ directories
- On Linux, creating directories under `/etc/easy-devops/` requires root. `ssl-manager.js` mkdir calls now use `sudo -n mkdir -p` followed by `sudo -n chown` to restore ownership, instead of failing with `EACCES`.

### Added

- `core/permissions.js` — new module with `setupLinuxPermissions()` and `checkPermissionsConfigured()`.
- `GET /api/settings/permissions` — returns `{ configured: boolean }`.
- `POST /api/settings/permissions/setup` — accepts `{ password }`, runs `sudo -S` setup, returns `{ success: true }` or `{ error }`.
- `isNginxTestOk(result)` exported from `core/platform.js` — the correct semantic check for nginx config validity on all platforms.

---

## [1.0.0] — 2026-04-03

This release is a major leap from the 0.x series. The most significant change is
the complete removal of external ACME binaries (certbot, wacs.exe) in favour of
a pure Node.js implementation using `acme-client`. Almost every part of the
project was touched — SSL, domains, nginx config, the dashboard UI, the CLI, and
the Linux installer.

### Breaking Changes

- **`certbotDir` config key renamed to `sslDir`** — if you have an existing
  `data/easy-devops.sqlite` config, the stored key name must be updated. The CLI
  and dashboard will show an empty SSL directory until you re-enter the path in
  Settings.
- **Certificate paths changed** — certs are no longer stored in certbot's
  `/etc/letsencrypt/live/` tree. New layout:
  - Linux: `/etc/easy-devops/ssl/{domain}/fullchain.pem` (and `privkey.pem`)
  - Windows: `C:\easy-devops\ssl\{domain}\fullchain.pem` (and `privkey.pem`)
  - ACME account key: `{sslDir}/.account/account.key`
- **`acmeEmail` config field required** — certificate issuance now fails
  immediately if no email is configured. Set it once in Settings or via the CLI
  and it is reused for every subsequent issuance.

---

### Added

#### SSL — acme-client (pure Node.js ACME)
- Replaced certbot (Linux) and wacs.exe / win-acme (Windows) with the
  [`acme-client`](https://www.npmjs.com/package/acme-client) npm package.
  No external binaries required on any platform.
- **HTTP-01 challenge**: Easy DevOps stops nginx, spins up a temporary Node.js
  HTTP server on port 80 to serve the ACME token, then restarts nginx after
  validation completes. No webroot configuration needed.
- **DNS-01 challenge**: Async callback flow. The CLI prompts the user to add the
  `_acme-challenge` TXT record and press Enter; the dashboard shows the record
  details and waits for a `/create-confirm` call before proceeding. DNS
  propagation is verified via `dns.promises.resolveTxt` before continuing.
- **Wildcard certificates** (`*.example.com`): Supported with automatic
  DNS-01 enforcement. Attempting HTTP-01 for a wildcard returns an error early.
  Certificate `altNames` is set to `[domain, *.domain]` automatically.
- **`acmeEmail`** field added to config, CLI settings menu, and dashboard
  Settings panel.

#### Domains
- **External URL backends** — the Backend Host field now accepts full URLs
  (`https://myapp.vercel.app/`). When a URL is detected, port validation is
  skipped and the generated nginx conf uses `proxy_pass` with the URL directly.
  The `Host` header is set to the upstream hostname instead of `$host`.
- **`proxy_ssl_server_name on`** — automatically inserted for HTTPS URL backends
  that are external hostnames (not IPs, not localhost). Enables SNI for services
  like Vercel and Railway. Omitted when nginx itself is terminating SSL.
- **Enable / Disable domain** — domains can be toggled without deleting their
  configuration. Disabling renames `.conf` → `.conf.disabled`; enabling does the
  reverse (with nginx config test + rollback on failure).
  - CLI: new "Enable / Disable Domain" menu option with status indicator.
  - Dashboard: Enable/Disable button on each domain row; disabled domains are
    grayed out with a "Disabled" badge.
- **Wildcard domain support** (`*.example.com`) — new Wildcard checkbox in both
  CLI add-domain flow and dashboard domain form.
  - Generates `server_name *.example.com example.com;` in nginx conf.
  - Forces DNS-01 validation for any SSL certificate on wildcard domains.
  - Hides HTTP-01 option in the cert creation section when wildcard is checked.
  - The `*.` prefix is added automatically by the system; users type only the
    bare domain (`example.com`).
  - Wildcard badge shown on domain cards in the dashboard.
- **Delete SSL cert with domain** — when deleting a domain whose SSL is enabled,
  a SweetAlert2 checkbox offers to also remove the certificate files from disk.

#### Dashboard
- **SweetAlert2** replaces all browser `confirm()` and `alert()` calls.
  Confirmation dialogs are styled to match the current theme (dark/light).
  The domain-delete dialog includes a checkbox to also delete SSL files.
- **Light / dark mode toggle** — fully working. CSS custom properties
  (`--body-bg`, `--sidebar-bg`, `--main-bg`, etc.) are set per theme via a
  `.light-mode` class on `<body>`. The sidebar, main content area, and all
  components respond correctly.
- **New color scheme** — background `#161616`, accent `#d64a29` (burnt orange).
  Surface color updated to `#1e1e1e` (neutral dark, not blue-tinted).
  Scrollbars, focus rings, button glows, and stat card hovers all derive from
  the accent via `--color-primary-rgb`.
- **Accent color picker** updated — the first circle now shows the new
  `#d64a29` orange-red as the default accent.
- **Multi-level subdomain support** — the domain name validator now accepts any
  depth (`abo.farghaly.dev`, `a.b.c.example.com`). Each label is validated
  individually (alphanumeric, hyphens allowed in the middle, no leading or
  trailing hyphens).
- **Domain form — wildcard UX** — when the Wildcard checkbox is checked:
  - The www-subdomain toggle is hidden (incompatible with wildcard).
  - An amber info box explains that DNS-01 is required.
  - The cert method selector hides the HTTP option.
  - An inline hint tells the user to type the bare domain only.

#### Code Organisation
- **`core/platform.js`** (new) — single source of truth for:
  `isWindows`, `getNginxExe(nginxDir)`, `nginxTestCmd(nginxDir)`,
  `nginxReloadCmd(nginxDir)`, `combineOutput(result)`.
- **`core/validators.js`** (new) — shared input validation:
  `validateDomainName`, `validatePort`, `validateEmail`,
  `validateUpstreamType`, `validateMaxBodySize`, `validatePositiveInteger`.
- `getConfDDir` exported from `core/nginx-conf-generator.js` and imported by
  `dashboard/lib/nginx-service.js` — no longer defined twice.

---

### Changed

- `core/config.js` — `certbotDir` renamed to `sslDir` throughout; `acmeEmail`
  added to defaults (empty string).
- `core/nginx-conf-generator.js` — imports `isWindows` from `core/platform.js`
  instead of declaring it; `getConfDDir` is now exported.
- `dashboard/lib/nginx-service.js` — imports `isWindows`, `getNginxExe`,
  `nginxTestCmd`, `combineOutput` from `core/platform.js` and `getConfDDir`
  from `core/nginx-conf-generator.js`. Extracted `assertNginxInstalled()` helper
  to avoid repeating the nginx binary check.
- `dashboard/routes/domains.js` — removed four duplicated nginx helpers and five
  duplicated validators; imports from `core/platform.js` and `core/validators.js`.
- `dashboard/routes/settings.js` — inline port/email validation replaced with
  calls to `validatePort` / `validateEmail` from `core/validators.js`.
- `cli/managers/domain-manager.js` — removed local copies of `isWindows`,
  `getNginxExe`, `nginxTestCmd`, `nginxReloadCmd`, `combineOutput`; imports
  from `core/platform.js`.
- `cli/managers/nginx-manager.js` — removed local `const isWindows`; imports
  from `core/platform.js`.
- `cli/managers/ssl-manager.js` — removed local `const isWindows`; imports
  from `core/platform.js`.
- `domain-manager.js` nginx test command on Windows now uses the correct
  explicit `-c conf/nginx.conf` flag (was missing it, unlike the dashboard route).

---

### Fixed

- **Multi-level subdomains rejected** — `abo.farghaly.dev` and similar domains
  were incorrectly rejected by `validateDomainName`. Fixed by splitting on `.`
  and validating each label separately.
- **`proxy_ssl_server_name` added for IPs and localhost** — the directive was
  generated for any HTTPS URL including `https://192.168.1.1`. Now only added
  for named external hosts; IPs and `localhost` are excluded.
- **Wildcard `*.` prefix in domain input** — users typing `*.example.com` would
  store the literal `*` in the name. The validator now strips `*.` defensively;
  the CLI `filter` does the same; the dashboard form shows a hint.
- **`nvm install` flooding the terminal** — on Linux, `nvm install` printed
  megabytes of download/compile output during installation. Output is now
  redirected to a temp file and only printed on failure.
- **Installer step shown three times** — `install.sh` printed all 7 steps as
  `[ ] pending` upfront, then reprinted each step as `[→] running` and
  `[✓] done` — three lines per step. The upfront pending block is removed;
  steps now appear once each as they run.
- **`nvm-bootstrap.sh` stray step messages** — internal `step_done` /
  `step_running` calls inside `bootstrap_nvm` interleaved with `install.sh`'s
  step display, creating confusing mixed output. Changed to plain `printf` calls.
- **`picker.sh` Ctrl-C leaves terminal in raw mode** — `trap '_tty_cleanup;
  return 2' INT TERM` inside a bash function: `return` from a trap handler does
  not exit the enclosing function. The terminal was left in raw mode on
  interruption. Fixed with a `_cancelled` flag; the loop checks it; `return 2`
  is called after cleanup.
- **`picker.sh` `stty` crash on empty saved state** — `stty "$old_stty"` called
  even when `stty -g` failed (e.g. non-TTY or dumb terminal), passing an empty
  string to `stty`. Added `[ -n "$old_stty" ]` guard.
- **Removed `console.log("startResult", ...)` debug output** from
  `dashboard/lib/nginx-service.js` `restart()` function.

---

### Removed

- All certbot and wacs.exe / win-acme integration code (executables, install
  helpers, spawn pipes, stdin auto-answer tricks).
- The "Install certbot" menu option from the CLI SSL manager.
- Local duplicate definitions of `isWindows`, `getNginxExe`, `nginxTestCmd`,
  `nginxReloadCmd`, `combineOutput` in `domain-manager.js`,
  `dashboard/routes/domains.js`, and `dashboard/lib/nginx-service.js`.

---

## [0.2.8] — prior release

Previous release before this session. No changelog was maintained for 0.x versions.
Key capabilities at that point: nginx manager, domain manager, basic SSL via certbot/wacs.exe,
Node.js version switching via nvm, web dashboard with authentication.
