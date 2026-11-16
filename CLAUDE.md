# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start              # Run the CLI (same as: easy-devops / ezz)
npm run dashboard      # Run the dashboard server directly (port 6443)
npm run build:ui       # Install and build the React dashboard into dist/ui
node . --dash --classic-ui # Serve the old EJS UI for this run
node . daemon          # Run the background worker in the foreground
node . runtime status  # The Node the service is pinned to, and the LTS options
node . cleanup         # Dry-run inventory of reclaimable files
npm run system-info    # Print detected system info and exit
npm test               # Run every e2e suite through e2e/run.mjs
npm run test:e2e -- service        # Run one suite
npm run test:e2e:check             # Preflight checks only
```

Pure ESM Node.js — backend and CLI files run directly, with no transpilation.

---

## Hard rules

These are the operative summary of `.specify/memory/constitution.md` (v2.0.0).
Spec-kit is no longer used day to day, so **this section carries the rules**. If
you change one here, change it there too — the constitution's Governance section
requires it.

### Architecture

1. **Shared logic lives in `src/core/`.** `src/cli/` and `src/dashboard/` are
   consumers only and must not duplicate each other.
2. **Single owners, no exceptions:**
   - `core/shell.js` — the only place that spawns a subprocess
   - `core/platform.js` — the only place with OS branching
   - `core/db.js` — the only database accessor
   - `core/nginx-conf-generator.js` — the only nginx config builder
   - `core/runner.js` — the only PM2 invoker
3. **No `process.platform` checks** outside `platform.js`.
4. **Cross-platform parity.** A feature must work on Linux and Windows, or be
   explicitly gated with a clear message on the unsupported one.

### Build

5. **The backend and CLI have no build step.** No TypeScript, no bundler, no
   compile step. Dependencies must be ESM-compatible or wrapped with
   `createRequire`.
6. **The dashboard UI may use a build step** (Vite + React), but: the published
   package ships **prebuilt** assets, installing must never require a build, and
   **the dashboard must never load code from a CDN at runtime.** (This reverses
   the old "Vue 3 from a CDN" rule — an operator's dashboard cannot depend on a
   third-party host.) **The React UI in `dist/ui` is the default; the classic
   EJS UI is a temporary fallback.** The server chooses at startup from
   `dashboardUi` (`new` | `classic`, for background services) or
   `--classic-ui` (one run, wins over the setting); `--new-ui` is still
   accepted as a no-op. A stored `classic` from before this change is migrated
   to `new` **once**, recorded by `dashboardUiMigrated`; after that a
   deliberate `classic` is never overridden. The React build is produced by
   `npm run build:ui` at publish time. A MISSING build prints
   `npm run build:ui` and falls back to classic — never fail to start. Do not
   delete the EJS files. The daemon serves no UI at all; this setting is only
   about the on-demand dashboard, and `ezz service status` shows it. Static
   UI files are public; **every** `/api` route and Socket.io handshake keeps
   the rules below in both UI modes. `files` in `package.json` must ship
   `dist/ui` and exclude the `src/dashboard/ui` sources and its `node_modules`.
7. **No new npm dependencies in easy-devops** without an explicit decision.
   PM2 and `pm2-logrotate` are installed into the *user's* environment, not
   depended on by the package.

### Data

8. **User data lives outside the package folder**, always:
   `~/.config/easy-devops/` or `%APPDATA%\easy-devops\`, and
   `C:\ProgramData\easy-devops\` once the Windows service is installed in
   Server mode (a service account cannot read the installing user's
   `%APPDATA%`). `npm update` wipes the package folder — a prior version lost
   configuration this way. The `EZ_TEST` guard in `getDataDir()` refuses
   **every** one of these directories, including ProgramData and anything
   inside it.
9. **`good.db`'s read cache stays disabled.** It is an in-process LRU with no
   invalidation, and several processes share one file. Enabling it broke
   cross-process change detection.
10. **No raw SQL.** Everything goes through `dbGet`/`dbSet`.

### Security

11. **Every dashboard API route and Socket.io connection is behind the shared
    auth gate** (`dashboard/lib/requireAuth.js`). Only the session check, login,
    logout and first-run setup are public.
12. **Passwords are scrypt-hashed** with a random salt, compared with
    `timingSafeEqual`. Never store plain text; migrate on next login. The
    minimum length is **6**, and `MIN_PASSWORD_LENGTH` in `core/passwords.js`
    is the only place it is written — the API publishes it as
    `minPasswordLength`, and every UI reads that rather than a literal.
13. **Login is rate-limited** (10 per 15 min per IP).
14. **"No password" is an explicit setting, never a blank one.**
    `dashboardAuth: 'none'` is honoured only while bound to loopback.
15. **Host / Origin / `X-EZ-Request` checks apply in every auth mode**
    (`dashboard/lib/localRequest.js`). They stop a hostile page in the same
    browser, which a password never did.
16. **`systemctl` from the dashboard always uses `sudo -n`.** Never interactive
    sudo. Never add broad sudoers rules — print the command for the user.
17. **Session secrets** come from `crypto.randomBytes(32)`, persisted in SQLite.
18. **First-run setup needs a one-time code** (`core/setupCode.js`).
    `POST /api/setup` is public by necessity — there is no session before the
    first password exists — so without a code whoever reaches a freshly started
    dashboard first owns it. Six digits, scrypt-hashed like a password, 24-hour
    expiry, per-IP rate limiting in its own budget, and a **global** cap of 20
    failed attempts that burns the code (only `ezz dashboard setup-code` issues
    another). `mode: 'none'` does not need it: that path already requires a
    loopback bind **and** a loopback request.
    **The code never leaves the machine.** It is printed to the local terminal
    and the local service log and nowhere else — not in any API response, not
    in a Socket.io event, not in the Hub agent's payloads, not in the settings
    backup. Only the hash is stored. Exactly five files may reach it, and
    `e2e/setup-code.test.mjs` fails if a sixth one does.

### Testing

19. **`npm test` must pass before any release.** Suites are plain Node under
    `e2e/`, run through `e2e/run.mjs`.
20. **No third-party test framework in easy-devops.** `hub_backend` keeps
    vitest; that is established and stays.
21. **Tests must never touch real state** — real data dir, real PM2, real nginx,
    real scheduled tasks, real hub database. This is enforced in code, not by
    convention:
    - `getDataDir()` throws under `EZ_TEST=1` if it would resolve the real
      directory
    - every suite's **first static import** must be `./lib/guard.mjs`
    - suites reach `src/` only through a **dynamic** `await import()`
    - where an external tool cannot be isolated by environment (PM2 on Windows
      ignores `PM2_HOME` — measured, not assumed), drive a **stub** and assert
      the stub is what runs
22. **Never run a suite directly.** `node e2e/x.test.mjs` is refused by design.
23. **Ad-hoc commands that import `src/` run with the test guard too.** Any
    `node -e`, one-off script or quick check that loads anything under `src/`
    MUST be invoked with `EZ_TEST=1` and a throwaway `EASY_DEVOPS_DATA_DIR`
    set as **real environment variables**, the way `e2e/run.mjs` sets them —
    before Node starts, not from inside the script. Then `getDataDir()`'s
    guard protects the command as well.

    Setting them inside the process does not work and must not be relied on:
    `core/db.js` resolves and OPENS the database while its module body is
    evaluated, so by the time any code of yours runs it is already too late.
    Passing `EASY_DEVOPS_DATA_DIR=...` after the script in an argument list is
    worse than useless — it becomes a positional argument, the variable is
    never set, and the command silently writes to the real installation.
    That is not hypothetical: it is how a stray key was written into a live
    database, and the guard is the only thing that would have refused it.

    ```bash
    # Right: real env vars, before node starts
    EZ_TEST=1 EASY_DEVOPS_DATA_DIR="$(mktemp -d)" node -e "import('./src/core/db.js')..."

    # Wrong: a positional argument, so the real data directory is used
    node -e "..." EASY_DEVOPS_DATA_DIR=/tmp/x
    ```

    The exception is a command whose whole purpose is to inspect the real
    installation. Then it must be **read-only** — `fs.readFileSync`, never a
    module that opens the database — and say so in its description.

### Contracts and docs

24. **`docs/api-contract.md` is authoritative** for dashboard REST endpoints and
    Socket.io events. Any change to an endpoint or event updates that file in
    the same change; `npm test` fails on a mismatch.
25. **Every user-visible change goes in `CHANGELOG.md`** under `[Unreleased]`.
26. **Versions move together:** `package.json`, `CHANGELOG.md`, and the CLI
    banner string.

### Simplicity

27. **Zero configuration by default.** The measure that settles design
    arguments is the time from `npm install` to a first domain serving HTTPS.
28. **Don't add a setting where a sensible default would do.** Every setting is
    a question asked of every future user. Detect rather than ask.
29. **Errors say what to do next**, not only what went wrong.

---

## Architecture

### Two entry points, one shared core

```
src/
  cli/           ← interactive terminal app (inquirer menus)
  dashboard/     ← Express + Socket.io web app (classic EJS UI + ui/ React source)
  core/          ← shared logic used by both
dist/ui/         ← built React dashboard (npm run build:ui, published, not committed)
```

**`src/core/`** is the source of truth for everything:
- `db.js` — SQLite via `good.db`. DB lives at `~/.config/easy-devops/easy-devops.sqlite` (Linux) or `%APPDATA%\easy-devops\easy-devops.sqlite` (Windows), never inside the package folder. The read cache is deliberately off.
- `platform.js` — `isWindows`, `getDataDir()` (with the `EZ_TEST` guard), nginx commands, PM2/service command builders. All platform branching lives here.
- `config.js` — loads/saves the `'config'` key. Always merge with defaults so new fields survive old databases, and migrate carefully: an upgrade must not change behaviour silently.
- `shell.js` — **all subprocess execution goes through here**: `run()` (captures output), `runLive()` (streams), `runInteractive()` (full stdio inherit, for commands that prompt — needs a real terminal), `runWithStdin()`.
- `passwords.js` — scrypt hashing for the dashboard password.
- `runner.js` — the only PM2 wrapper, now for the user's OWN apps (the
  Processes page). There is no `core/service.js`: the PM2-era install path was
  deleted once nothing routed to it. The service lives in `service/` below.
- `service/` — the native OS service: `index.js` (the dispatcher), `systemd.js`,
  `windowsService.js` (WinSW), `windowsPersonal.js`, `winsw.js` (the pinned
  wrapper), `runtime.js` (the pinned Node), `runtimeUpdate.js` (moving the
  service onto another Node, with rollback), `acl.js`, `dataDir.js`,
  `legacy.js`.
- `installSource.js` — whether this copy is an npm install or a git clone, and
  therefore how it is updated. **Check it before running npm:** on a clone
  `npm install -g` installs a second copy from the registry and leaves the
  service running the clone, so the update reports success and changes nothing.
- `updater.js` — `ezz update`: stop, replace, refresh the Windows Server
  runtime copy, start, verify against the daemon's heartbeat, roll back.
- `cleanup.js` — the reclaimable-file inventory. Scans, never deletes unless
  handed specific items.
- `purge.js` — `ezz uninstall --purge`: export a backup first, then remove the
  service, the runtime and the data directory. nginx and the sites stay.
- `setupCode.js` — the one-time first-run setup code (rule 18).
- `probeCache.js` — cache with background refresh for probes that cost a
  subprocess. **On Windows one spawn costs about a second**, which is why
  `GET /api/service` took twenty: six of them, in sequence. Serve the cached
  answer, refresh behind the response, and `invalidate()` whenever a command
  changes what was measured.
- `permissions.js` — Linux-only sudoers setup.
- `validators.js` — shared input validation.
- `nginx-conf-generator.js` — builds nginx `.conf` content. `nginx-apply.js` writes, tests and rolls back.
- `hubLink.js`, `hubPermissions.js` — hub pairing and the permission catalog.
- `nginx-service.js`, `cert-reader.js`, `domains-db.js`, `cert-operations.js` —
  nginx control, certificate reading, the domain store and the certificate
  actions the Hub can request. These were in `dashboard/lib/` until the daemon
  needed them; core must not import from `dashboard/`.
- `hub/agent.js` — the outbound agent to the Hub. Background work, so it starts
  and stops with job ownership, not with the dashboard.
- `jobs/` — the background work and who runs it. `bus.js` (in-process event
  channel, using the api-contract event names), `monitors.js` (nginx status,
  domain health, cert expiry), `revisionWatcher.js`, `owner.js` (the exclusive
  jobs-ownership marker: pid + heartbeat, claimed before anything starts and
  released after everything stops), and `index.js` (`startJobs({ role })` — the
  owner election).
- `daemon/` — `lock.js` (single-instance lock: pid + heartbeat, stale only when
  BOTH say so, plus `watchLock()` so a dashboard sees a daemon appear at once),
  `ipc.js` (named pipe / Unix socket, **server → client only, no commands
  accepted**), `run.js` (`ezz daemon`).
- `notifications/` — `claim.js` (atomic cross-process claim) and `dispatch.js`
  (evaluate → claim → send → commit; never mark sent before sending).

### Background jobs run in exactly one process

Monitoring, notifications and the Hub agent are owned by whichever process won
the election in `core/jobs/index.js`:

- **`ezz daemon`** takes the lock and runs them for as long as it holds it.
- **An open dashboard** never takes the lock. It runs them only while no daemon
  holds it, and stands down the moment one appears.

The dashboard deliberately does not take the lock: otherwise `ezz daemon` would
refuse to start while a browser tab was open.

**The hand-over is immediate and exclusive, and both halves are required.** The
dashboard watches the lock file (`watchLock()`, `fs.watch` on the DIRECTORY —
the file does not exist when no daemon runs) as well as polling every 15s, and
the daemon waits for the jobs marker in `core/jobs/owner.js` to be released
before it starts the Hub agent or any monitor. The wait is bounded: after
`HANDOVER_WAIT_MS` it starts anyway and says why, because a daemon that
monitors nothing is worse than a brief overlap. One poll of overlap used to be
acceptable; it is not — two Hub agents with the same `serverId` make the Hub
evict them in turn. The notification claim remains the backstop: even with two
runners, a transition is sent exactly once.

Events reach the browser by one path only: `core/jobs/` publishes to the bus,
and `socketManager.js` forwards. When a daemon owns the jobs,
`dashboard/lib/daemonBridge.js` republishes its IPC frames onto the same bus,
so nothing downstream knows or cares which process produced an event.

### The native service (`core/service/`)

`ezz service install` registers a native OS service that runs `ezz daemon`:

| platform / mode | mechanism | elevation | starts |
|---|---|---|---|
| Linux | systemd unit (`/etc/systemd/system/easy-devops.service`) | sudo once | at boot |
| Windows "Server" | Windows Service via WinSW | UAC once | at boot |
| Windows "Personal" | Startup-folder supervisor | none | at logon |

Rules that are not negotiable here:

- **Never ask for, store, or pass through a password.** On Linux sudo does its
  own asking on the user's terminal. On Windows the service runs as the virtual
  account `NT SERVICE\EasyDevOps`, which has no password. The old Task
  Scheduler mode needed the user's password and has been **removed**;
  `core/service/legacy.js` exists only to find and offer to remove it.
- **`core/service.js` is gone.** Its PM2 install/uninstall path was superseded
  by `core/service/` and has been deleted; `backgroundServiceState()` and
  `status()` in `core/service/index.js` are the only sources for service state,
  and `GET /api/service` publishes it under `backgroundService`. PM2 still runs
  the user's OWN apps, which is a supported feature.
- **WinSW is pinned and hash-verified** (`core/service/winsw.js`). Install
  refuses on a mismatch; it does not warn and continue.
- **ACL grants come from the live Settings**, never a hardcoded `C:\nginx` or
  `C:\ssl`, and are compared on every `status` so a changed path surfaces as
  "run `ezz service repair`".
- **The runtime is pinned** so a version manager cannot break the service: a
  symlink on Linux, a copy into ProgramData on Windows Server, a recorded
  absolute path in Personal mode. Native modules are verified by actually
  loading `better-sqlite3` with the target binary, not by comparing ABI
  numbers.
- **"The service manager started it" is not "the daemon is running."** Both
  WinSW and systemd report success as soon as a process is spawned. After
  starting, wait for the daemon's heartbeat (`waitForDaemon()`); on timeout
  report FAILED with the last log lines.
- **`core/service/` never prompts.** Every question is asked by the CLI and
  passed in as an option, so the core stays callable without a TTY and the
  dashboard cannot trigger anything interactive.
- **`ezz runtime update` smoke-tests before it touches anything**, and never
  uninstalls a Node version. The order is: pick a target above the
  `engines.node` minimum, prove the new binary can run Easy DevOps AND load
  better-sqlite3 while the service is still up, then stop, swap (keeping
  `node.exe.prev` / the previous link target / the previous recorded path),
  start, and wait for the daemon's own heartbeat — not the service manager's
  "started", which only means a process was spawned. Any failure rolls back.
  The old runtime is what a rollback needs, which is why nothing removes it;
  `ezz cleanup` offers the leftover copy afterwards.
- **A Windows Server runtime change is refused without elevation, before
  anything is stopped.** `canWriteProgramData()` is the probe, and the answer
  is the command plus "Run as administrator" — never a password prompt.
- **Status has a cheap half and an expensive half, and they are kept apart.**
  The daemon lock, its heartbeat, the stop request and the recorded install
  details cost microseconds and are read FRESH on every call — they are also
  the only things that change on their own. The service manager's view, the
  pinned runtime's `--version`, the legacy PM2 scan and PM2 detection each cost
  a subprocess; they run in **parallel** and, for the dashboard, come from
  `core/probeCache.js`. `status()` is uncached by default so the CLI measures
  afresh; `status({ cache: true })` is what the dashboard calls. Anything that
  changes the answer calls `invalidateProbes()`, and the dashboard also drops
  the cache when `service:changed` fires — a TTL alone would show "not
  running" to someone who had just pressed Start.

In Windows Server mode the data directory becomes
`C:\ProgramData\easy-devops` for the service, the CLI and the dashboard alike —
a virtual account cannot read the installing user's `%APPDATA%`. It is migrated
once (copy → verify → back up → remove, never a rename: the two can be on
different volumes). A `.server-mode` marker, not the service's running state,
is what selects it; **uninstall never silently moves the data back** — it asks,
and the default is to keep the server location.

### CLI (`src/cli/`)

`index.js` is a thin bootstrap: it parses flags **before** importing anything
that reaches `core/db.js`, because the data directory must be decided first.
The same ordering applies to `--classic-ui`, which sets
`EASY_DEVOPS_CLASSIC_UI` before `dashboard/server.js` is imported.
Subcommands: `system-info`, `daemon`, `service <action>`,
`runtime <action>`, `update`, `cleanup`, `uninstall --purge`,
`dashboard setup-code`.

The last four are CLI-only on purpose, and the reason is the same each time:
each one stops or replaces the process that would have served the request.
`ezz update` replaces the running package; `ezz runtime update` swaps the
binary the service runs; `--purge` deletes the database the dashboard reads;
and the setup code exists precisely to prove the caller can read this
machine's terminal. `core/updater.js` exports `whyCliOnly()` so that
explanation is given to the user rather than only written in a comment.

- `menus/` — thin dispatchers. `managers/` — the actual logic.

### Dashboard (`src/dashboard/`)

`server.js` creates the Express app, the session middleware (shared with
Socket.io so sockets see the same session), the local-request guard, the
routers, the UI choice (the built React app in `dist/ui` with an SPA fallback,
or classic EJS), and the standby job runner plus the daemon bridge.

- `routes/` — `auth.js` (the only public router), `domains.js`, `ssl.js`, `nginx.js`, `settings.js`, `hub.js`, `processes.js`.
- `lib/requireAuth.js` — the single auth gate, HTTP and socket.
- `lib/localRequest.js` — Host/Origin/`X-EZ-Request` checks.
- `lib/daemonBridge.js` — the IPC client; republishes the daemon's events onto
  the local job bus, answers "is the background service running?" (from the
  lock, not from whether its socket happens to be connected), and publishes
  `service:changed` when that answer changes — once per real change, so an
  ordinary restart does not flicker the banner.
- `socketManager.js` — the browser-facing socket layer. It does **no**
  monitoring: it forwards bus events and owns the live log tails only. The
  state-like events (`nginx:status`, `domain:health`, `service:changed`) are
  cached and replayed to each new connection; `notification:new` is not — it is
  a thing that happened, and replaying it would announce old outages.
- `controllers/processesController.js` — `GET /api/service` (the native service
  state under `backgroundService`) and `POST /api/service/start|stop|restart`.
  The dashboard never elevates and never prompts: an action that needs
  elevation answers `403 elevation_required` with the exact command and shell.
- `views/` — EJS. `public/js/app.js` — the classic Vue app; all its UI state
  lives here.
- `ui/` — the React dashboard source (separate package, own `node_modules`).
  Built to `dist/ui`; served only when selected.

### Critical Linux behaviour

- **`nginx -t` never uses sudo** — it's read-only. But on Linux it exits 1 after printing "syntax is ok" because it cannot write `/run/nginx.pid`. Always check with `isNginxTestOk(result)`, never `result.success`.
- **`systemctl` always uses `sudo -n`** in dashboard code. Requires NOPASSWD sudoers — configured once via `Settings → Linux Permissions`.
- **`runInteractive`** needs a real terminal. Dashboard routes must always use `run()`.
- **Detecting start-on-boot never runs `pm2 startup`** — that command *installs* the hook when it can. Read `systemctl is-enabled pm2-<user>` instead, and report *unknown* on non-systemd systems.
- **A status read must never start the PM2 daemon.** Every pm2 command does, so check the daemon's pid file first.

### Data storage

| SQLite key | Contents |
|---|---|
| `config` | dashboardPort, dashboardBindAddress, dashboardAuth, dashboardUi, dashboardPasswordHash, nginxDir, sslDir, acmeEmail, … |
| `domains` | JSON array of domain config objects (v2 schema) |
| `hub-link`, `hub-permissions`, `hub-revision` | Hub pairing, granted permissions, change counter |
| `service-state` | Recorded boot mode and install time |
| `system-detection` | Cached OS/nginx/node detection |
| `session_secret` | Generated once via `crypto.randomBytes(32)` |
| `notification_channels`, `domain_notification_config`, `notification_state` | Notifications |

SSL certs are on the filesystem under `sslDir` — not in SQLite.
