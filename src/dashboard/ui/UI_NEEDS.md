# UI needs from the backend

What the new UI needs that `docs/api-contract.md` and the current backend do not
provide yet. Items 1–2 block shipping the built bundle; the rest are contract
accuracy and data-shape clarifications that the UI already works around.

## 1. Serve the built UI behind `--new-ui` — done

Implemented in `src/dashboard/server.js`. `--new-ui` (or the `dashboardUi: "new"`
setting) serves `dist/ui` at `/`; `index.html` and the SPA fallback are
`no-cache`, hashed `/assets/*` are immutable, `/api` and `/socket.io` are
unchanged, and a missing build prints `npm run build:ui` and falls back to the
classic UI. `npm run build:ui` builds the bundle; the published package ships
`dist/ui`.

## 2. Document the process-log response shape (blocking)

`GET /api/processes/:name/logs` is documented as “Recent lines for one process”.
The real response is:

```json
{ "name": "easy-devops", "lines": ["...", "..."] }
```

The UI originally assumed `{ logs: "..." }` and crashed against the real
dashboard. Please pin the shape (and the maximum number of lines) in §2.7.

## 3. Nginx logs: access vs error

§2.4 documents `GET /api/nginx/logs` as “Recent access/error lines”, but the
endpoint returns only the last 100 **error** lines and accepts no file selector.
Either add `GET /api/nginx/logs?file=error|access&lines=N` or correct the contract
to say error-only. The UI does not use this endpoint for display; both log views
are fed by the socket tail, so access history is unavailable before subscribing.

## 4. Document that `nginx.version` already carries the `nginx/` prefix

Live and REST status return e.g. `"nginx/1.26.2"`. The UI renders it as-is. Worth
one line in §2.4 so no client double-prefixes it.

## 5. `service.cliHint` is a sentence, not a command — superseded in 2.0.0

`GET /api/service` returns `cliHint` as a complete sentence with the command in
backticks, e.g. ``Run `ezz service install` in an Administrator PowerShell to set
up the service.`` The UI no longer reads it (see #11; the sentence mixes PM2 and
the Easy DevOps service). If it stays, document the format or split it into
`cliCommand` and `cliDescription` so clients do not need to parse prose.

Contract 2.0.0 removed `cliHint` along with the other PM2-era fields;
`install { command, needsElevation, shell }` is the structured replacement and
the UI reads only that. Nothing left to do here.

## 6. Pin the SSL certificate object

`GET /api/ssl` is documented as “List certificates with expiry and status”. The
UI relies on:

```json
{ "domain": "example.com", "expiry": "2027-01-02T…", "daysLeft": 50, "status": "valid" }
```

with `status` ∈ `valid | expiring | expired | error`, `expiry`/`daysLeft` nullable
for unreadable certificates, and **negative** `daysLeft` for expired ones (the UI
shows “Nd overdue”). Please document these fields.

## 7. Pin `sslPathWarning` on domains

`GET /api/domains` can include `sslPathWarning: true` when certificate paths were
stored with backslashes, which nginx on Windows can fail to load. The UI shows a
“Backslash cert paths” badge whose tooltip says to open and save the domain so the
paths are regenerated with forward slashes. The contract does not mention the
field; please document its name and meaning (or rename it to something
self-describing).

## 8. Document the log-replay behavior on subscribe

The socket replays the last 50 lines on **every** `logs:subscribe`, in addition
to streaming new lines (PowerShell `Get-Content -Tail 50 -Wait`, `tail -n 50 -f`).
The UI clears its buffer before each subscribe so reconnects replace the tail
instead of duplicating it. A note in §3.2 would save the next client that
duplication bug.

## 9. Decide on the first-run setup code — done in 2.1.0

Resolved by contract 2.1.0: `GET /api/auth` now advertises
`setupCodeRequired` and `setupCodeExpiresAt`, and `POST /api/setup` accepts
`setupCode`. The first-run screen collects the code when required. When the
contract reports a required code with `setupCodeExpiresAt: null` — the code is
past its 24 hours or was burned after 20 failed attempts — the screen shows
“This code has expired. Get a new one with: ezz dashboard setup-code” instead
of calling the submission invalid. `?mock=setupcode` (`123456`) and
`?mock=setupcode-expired` exercise both paths.

## 10. Document the remaining payload shapes the UI consumes

These are used in full but only named in the contract:

- `GET /api/service` `pm2` → `{ installed: boolean, version: string|null, path: string|null }`
- `GET /api/processes` items → `name, pmId, pid, status, cpu, memoryBytes, startedAt, uptimeMs, restarts, unstableRestarts, execPath, cwd, user, managed, dataDir`, plus top-level `pm2, apps, currentUser, pm2Home?, hint?`
- `GET /api/settings/channels` items → `id, name, type: "discord"|"telegram", webhookUrl?, botToken?, chatId?, message?`
- `GET/PUT /api/domains/:name/notifications` → a map keyed by `nginx_down | cert_expiry | domain_health`, each `{ enabled, channelIds: string[] }`

Pinning these would let the contract tests cover the UI adapter directly.

## 11. Expose the native background-service state in `GET /api/service` — done in 2.0.0

Phase 1 moved Easy DevOps from a PM2 app to a native daemon, but the HTTP
response still describes the old model. On a machine where the daemon **is**
running, `GET /api/service` currently returns:

```json
"installed": false, "running": false, "status": null, "app": null,
"enabledOnBoot": false, "bootMode": "personal",
"backgroundService": { "running": true, "connected": true, "pid": 51404, ... }
```

so any client reading `installed`/`running` renders “Not installed” while the
service is up. `src/core/service/index.js` already computes the right answer;
please return it (preferably inside `backgroundService`, which the UI treats as
the single authority) and stop relying on the PM2-era fields for the daemon:

```json
"backgroundService": {
  "running": true,
  "connected": true,
  "pid": 51404,
  "version": "1.2.1",
  "startedAt": 1794691485390,
  "jobsRunningHere": false,
  "mechanism": "startup-supervisor",   // "startup-supervisor" | "winsw" | "systemd"
  "mode": "personal",                  // "personal" | "server" | null
  "installed": true,                   // native install, not a PM2 app
  "startsAt": "logon",                 // "logon" | "boot"
  "stoppedByUser": false,              // explicit stop recorded / stop marker
  "stoppedAt": null,                   // ISO timestamp when known
  "warnings": [],                      // core/service status warnings
  "runtime": {
    "systemNode": { "path": "C:\\Program Files\\nodejs\\node.exe", "version": "24.18.0", "abi": "137" },
    "pinned": { "kind": "copy", "path": "…", "version": "24.18.0",
                "exists": true, "broken": false, "differsFromSystem": false },
    "warnings": []
  }
}
```

Until these fields exist the UI infers the mechanism from the recorded
`bootMode` plus `install.shell`/`needsElevation`, and shows `installed`,
`startsAt`, “stopped by you” and the Node runtime as **Unknown** rather than
guessing. `installed` cannot be derived from `running`: a daemon started by hand
runs without being installed.

Deprecate for the daemon: `installed`, `running`, `status`, `app`, `appName`,
`enabledOnBoot`, `bootMode`, `bootDetail`, `sameUser`, `currentUser`,
`appUser`, `pm2Home`, `daemonRunning`, `canInstallFromDashboard`, `cliHint`.
Keep `pm2`, `dev`, `dataDir` and `install { command, needsElevation, shell }`:
the UI uses those for “your own PM2 apps”, the dev badge, the data directory and
the per-mode install guidance.

Shipped as requested in contract 2.0.0. `GET /api/service` is now
`{ backgroundService, pm2, dev, dataDir, install }`; `backgroundService` carries
every field above plus `heartbeatAgeMs`, `jobsOwnerPid`, `jobsOwnerRole`,
`dataDir`, `serverMode` and `detail`, and the full status adds `state`,
`enabledOnBoot`, `restarts`, `crashLooping`, `warnings` and `runtime`. The
PM2-era top-level fields are gone and the UI no longer reads or infers them.
Note that `service:changed` and the lifecycle responses carry the cheap half
(no `state`/`runtime`/`warnings`), so the UI overlays that snapshot and re-fetches
`GET /api/service` for the rich fields.

## 12. Add native `POST /api/service/start|stop|restart` — done in 2.0.0

The UI has no service controls because the only existing endpoint,
`POST /api/service/restart`, restarts the PM2 app `ez-dashboard` — wrong target
under the native model, so the button was removed. Please add:

- `POST /api/service/start` — `not_installed` when there is no native install;
  otherwise launch the supervisor/service. Returns `{ ok, output, backgroundService }`.
- `POST /api/service/stop` — stop the daemon and record “stopped by you” (the
  supervisor must not relaunch it until start/restart or the next logon/boot).
- `POST /api/service/restart` — stop + start, clearing the stopped-by-you marker.

Errors need machine-readable guidance: Windows service mode requires an
Administrator context, and systemd requires sudo. Return e.g.
`403 { "error": "elevation_required", "command": "…", "shell": "Administrator PowerShell" }`
instead of failing opaquely; the UI will show the command rather than pretend
it can elevate. The UI will add start/stop/restart buttons once these exist.

Shipped as requested in contract 2.0.0: success returns
`{ ok, action, output, backgroundService }`; `403 elevation_required` carries
`action`, `message`, `command` and `shell` (Windows Server mode and systemd have
different commands); `409 not_installed` carries `command: "ezz service install"`;
`409 already_running` and `500 action_failed` carry `backgroundService`. The
Processes card now has Start / Stop / Restart with confirmations, renders the
elevation command with a copy button, and treats `already_running` as an
informational toast.

## 13. Update the contract to the native service model — done in 2.0.0

`docs/api-contract.md` is **version 1.4.0** (the UI task referenced 1.2.0) and
§2.7 still documents the removed model: a Task Scheduler task, a PM2 app named
`ez-dashboard`, “Windows must ask for the account password”, and the old
`installed`/`running`/`enabledOnBoot` fields. Please rewrite §2.7 around
`backgroundService` (#11) and the lifecycle endpoints (#12), and drop the
password wording: the Windows service runs as `NT SERVICE\EasyDevOps` and never
needs an account password.

Contract 2.0.0 does exactly that. It also documents the `service:changed` socket
event, which the UI now uses to update the card, banner, sidebar and overview
without a reload, with a 15 s GET fallback while the Processes page is open and
on socket reconnect. No open items remain in #11–#13.
