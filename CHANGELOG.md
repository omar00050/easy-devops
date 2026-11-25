# Changelog

All notable changes to Easy DevOps are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

## [1.4.7] — 2026-11-25

**Security and availability.** Every security fix from 1.4.4, 1.4.5 and 1.4.6 is
still here. 1.4.7 repairs the upgrade failures those releases caused: an
administrator locked out of the Windows service files, a Linux service that
would not start again after an update, and a Windows service left running an
older version without saying so. If this server updated to 1.4.4, 1.4.5 or
1.4.6, read "If you updated to 1.4.4, 1.4.5 or 1.4.6" below first.

### Fixed

- **Windows: an administrator is no longer locked out of the service files.**
  File protection removed inheritance from the files under `bin` and `runtime`
  before it wrote the permissions for the folders, so a file that existed, was
  copied or was renamed while the protection ran could end with an access list
  that had no entries at all. Nobody could open it — not SYSTEM, not
  `BUILTIN\Administrators` — which is the `EPERM` reading
  `bin\EasyDevOps.exe` and the reason the service would not start. Protection
  now grants the folder first, keeps its files inheriting from it, removes
  entries nobody approved, and reads the whole tree back. If SYSTEM,
  Administrators or `NT SERVICE\EasyDevOps` cannot read `EasyDevOps.exe`,
  `node.exe` or `runtime\app\src\cli\index.js`, it puts the previous
  permissions back and stops with the command to run.
- **Windows: the start error names the real problem.** Starting the service
  failed with "Starting the Windows service was refused for this account" even
  when the account was fine and the service program itself could not be read.
  That case now says the service program cannot be read, that it is a file
  permission problem, and to run `ezz service recover`. The refusal message is
  kept for a genuine refusal against the service.
- **Windows Server: the service no longer stays silently on an old version.**
  A plain `npm i -g easy-devops` updates the command you type, while the
  service keeps running its own copy in
  `C:\ProgramData\easy-devops\runtime` — the old code, with its old security
  problems, and nothing said so. Every `ezz` command now compares the two
  versions, warns with both, and names `ezz service repair`; in an interactive
  terminal it also offers the existing "Relaunch as administrator?" flow. (The
  daemon and the repair and recover commands themselves skip the warning — they
  are the fix.)
  `ezz service status` shows `Service version` and `CLI version`. The daemon
  checks at start and every six hours and reports a newer installed package
  once — a notification, a field in the Hub's service state and a banner in the
  dashboard. Nothing repairs itself.
- **A Windows update no longer ends silently with the service stopped.** The
  update could stop right after "node.exe is already the runtime copy (...);
  kept" and print nothing. Every step now fails through one place that prints
  the step, the error and the exact command to run next, and a service that was
  stopped is put back before the update returns: it ends running the old
  version or the new one, never stopped.
- **The daemon no longer crashes when a state file is being read.** On Windows
  a rename over a file another process has open is refused with `EPERM`,
  `EBUSY` or `EACCES`, and the daemon died from it while rewriting
  `jobs.owner`. Every small state file — `jobs.owner`, `daemon.lock`,
  `daemon-state.json`, `update-status.json`, notification claims and the stop
  request — is now written through one module that retries briefly before it
  gives up, and a failed heartbeat is logged once and retried on the next beat
  instead of ending the process.
- **"Stopped by you" is reported only while it is true.** Status showed
  "stopped by you at ..." while the service was running, because it was taken
  from an old recorded stop. It now comes only from a live stop request with no
  running daemon, and every start path clears it — start, restart, install,
  repair, recover, update, `sc.exe start`, and the daemon taking its lock. A
  status read never clears it, so a dashboard poll cannot cancel a stop.
- **Linux: a database startup failure shows the real cause.** The message was
  the same "check that the current user has write access" whatever had
  happened; on the real server it ran as root and permissions were fine. The
  error now prints the step that failed and the original error with its code,
  and the advice follows the cause: a native module that does not load says how
  to rebuild it, a lock names `fuser`/`lsof`, a corrupt or non-database file
  says to copy it aside and keep it, a full disk says so. `ezz service status`
  runs the same check, read-only: can the package load `better-sqlite3`, can
  the database be opened read-only, which process is holding it.
- **Linux: the systemd unit is generated from a template.** The old code
  inserted text at a `[Service]` header it found inside a comment, so
  `Environment=` lines landed in `[Unit]` and systemd ignored them. Every key
  now comes from a structured template and goes in its own section, and the
  writer refuses a duplicated key or a key that would sit inside a comment.
  Resource tuning an operator set by hand (`LimitNOFILE` and the like) is
  carried over instead of dropped.
- **A rollback leaves a working service.** Rollback reinstalled the previous
  package but left the new systemd unit or WinSW XML and the new Windows
  runtime copy in place, so a rollback could leave a service that could not
  start. Rollback now restores the package, the service definition and the
  runtime together, starts it, and waits for the old daemon's own heartbeat;
  success is no longer "the service manager accepted the start". Anything it
  cannot restore is named, with the command to run.
- **The new version's own setup runs before its service does.** An update is
  performed by the version already installed, so the new version's required
  setup — unit or XML, runtime copy, native-module check, protections, stubs —
  was never applied before the new daemon started. After `npm install` the
  updater now runs the newly installed package's own post-update step in a new
  process, before the service starts. Installing a version older than 1.4.7
  falls back to this version's repair step.
- **Installers.** The one-line commands from the README work again:
  `curl -fsSL .../install.sh -o install.sh && bash install.sh`, the `wget`
  form, and `Invoke-WebRequest ... -OutFile install.ps1; ./install.ps1`. A
  standalone copy of `install.sh` downloads the helper modules it is missing
  into a private `0700` temporary directory and verifies each one against the
  SHA-256 pinned in the script before using it; an unverified helper is never
  sourced. `install.ps1` works as a standalone download — it finds the
  installed package with `npm root -g` and says what to install when it cannot
  — and on a Windows machine without Node it offers
  `winget install --id OpenJS.NodeJS.LTS`. `install.bat` maps its flags
  (`--keep-node`, `--service`, `--no-service`, `--yes`, `--non-interactive`,
  `--version`) to the PowerShell script.

### Added

- **`ezz service recover`** repairs a service broken by an earlier upgrade.
  On Windows, from an Administrator PowerShell: it takes ownership for
  Administrators where that is needed, resets only the files under `bin` and
  `runtime`, verifies every file keeps SYSTEM and Administrators full control
  and the service account read and execute, restores the service security
  descriptor to the Windows defaults plus the installing account's start, stop
  and query grant, then runs the normal repair. If even the elevated
  administrator is refused, it prints the exact commands to run as LocalSystem
  (`psexec -s -i powershell`, or a one-shot scheduled task). It resets only the
  code folders — `bin`, `runtime` and `runtime.prev` — and on the data folder
  it only adds SYSTEM and Administrators, never a recursive reset, so no
  database, setting, certificate or deployment is changed. On Linux it
  regenerates a valid unit and restarts the service, asking sudo when it is not
  root. `ezz service repair` and `ezz service recover` also finish an
  interrupted update first.
- **An update journal.** Before the package is replaced, the updater records
  the service definition and (on Windows Server) the runtime copy in
  `update-journal.json` and puts the originals aside. After a successful start
  it removes the journal; a new update, `repair` or `recover` uses it to put an
  interrupted update back before reading or replacing those files. Only the
  service's own folder, the snapshot and the journal are ever removed — never
  user data.

### If you updated to 1.4.4, 1.4.5 or 1.4.6

Those releases could lock an administrator out of the Windows service files or
leave the Linux service unable to start. 1.4.7 repairs both. Two steps:

1. **Update.**

   ```bash
   npm install -g easy-devops@1.4.7
   ```

2. **Recover, then look at the result.**

   Windows Server, in an **Administrator PowerShell**:

   ```powershell
   ezz service recover
   ezz service status
   ```

   `ezz service status` must show the same version on `Service version` and
   `CLI version`, and `C:\ProgramData\easy-devops\logs\EasyDevOps.out.log` must
   start with `Easy DevOps daemon v1.4.7`.

   Linux:

   ```bash
   ezz service recover
   ezz service status
   ```

   It asks for sudo unless you are root. `systemctl status easy-devops` must
   report active, and `journalctl -u easy-devops -n 50` must not repeat
   `Failed to initialize database`.

Nothing else is needed: do not reinstall, do not delete the database, and do
not re-run the update to "make sure".

**If `ezz` itself cannot run**, do the same recovery by hand. Start with a
read-only capture, so the state is known before anything changes.

Windows, Administrator PowerShell:

```powershell
whoami /groups
sc.exe sdshow EasyDevOps
icacls "C:\ProgramData\easy-devops"
icacls "C:\ProgramData\easy-devops\bin"
icacls "C:\ProgramData\easy-devops\runtime"
icacls "C:\ProgramData\easy-devops\bin\EasyDevOps.exe"
icacls "C:\ProgramData\easy-devops\runtime\node.exe"
icacls "C:\ProgramData\easy-devops\runtime\app\src\cli\index.js"
```

If a file shows no entries at all, reset only the files under `bin` and
`runtime`, give the service account read and execute on both folders, and start
the service:

```powershell
icacls "C:\ProgramData\easy-devops\bin\*" /reset /T /C /Q
icacls "C:\ProgramData\easy-devops\runtime\*" /reset /T /C /Q
icacls "C:\ProgramData\easy-devops\bin" /grant "NT SERVICE\EasyDevOps:(OI)(CI)RX"
icacls "C:\ProgramData\easy-devops\runtime" /grant "NT SERVICE\EasyDevOps:(OI)(CI)RX"
sc.exe start EasyDevOps
```

If a reset is denied with "Access is denied", take ownership of those files for
Administrators first, then repeat the reset and the grants:

```powershell
icacls "C:\ProgramData\easy-devops\bin\*" /setowner *S-1-5-32-544 /T /C /Q
icacls "C:\ProgramData\easy-devops\runtime\*" /setowner *S-1-5-32-544 /T /C /Q
```

If even that is denied — the elevated token itself is refused — run the same
reset and grant blocks as LocalSystem, with a PsExec that is already on the
machine (`psexec -s -i powershell.exe`, `whoami` must print
`nt authority\system`) or a one-shot scheduled task whose user is SYSTEM.
These are the commands `ezz service recover` prints for that case. Leave the
SYSTEM session as soon as the ACLs are repaired.

Linux, on the root install the failure was seen on. Run it as root; if you are
not root, prefix each command with `sudo`. Only the copy test writes anything,
and only to `/tmp`:

```bash
ls -la /root/.config/easy-devops/

cd /usr/lib/node_modules/easy-devops
npm ls better-sqlite3 good.db
ls -la node_modules/better-sqlite3/build/Release/

/root/.config/easy-devops/runtime/node -e 'const D=require("better-sqlite3");const db=new D("/root/.config/easy-devops/easy-devops.sqlite",{readonly:true,fileMustExist:true});console.log(db.prepare("select name from sqlite_master").all())'

cp /root/.config/easy-devops/easy-devops.sqlite /tmp/ez-copy.sqlite && node -e 'const D=require("better-sqlite3");new D("/tmp/ez-copy.sqlite").exec("create table if not exists _t(x)");console.log("write OK")'

fuser -v /root/.config/easy-devops/easy-devops.sqlite*
```

What the answers mean:

- **`better-sqlite3` missing, or the addon built for another Node** — rebuild
  it in the package folder, with the Node the service runs:
  `cd /usr/lib/node_modules/easy-devops && sudo npm rebuild better-sqlite3`.
- **The read-only open fails with `SQLITE_CORRUPT` or `SQLITE_NOTADB`** — stop
  here. Keep the file and its `-wal`/`-shm` sidecars, take a copy, and report
  it with the exact error. Never delete or recreate the database.
- **`fuser` names a process** — that leftover process is holding the database.
  Identify it, stop only a confirmed leftover Easy DevOps process, then start
  the service again.
- **Everything succeeds** — the database is fine: install 1.4.7 and run
  `ezz service recover` as above.

Never run a recursive ACL reset (`/reset /T`) on `C:\ProgramData\easy-devops`
itself: the database, settings, certificates, deployments and logs are user
data, and the reset silently removes their permissions and ownership. And
never delete or recreate the `.sqlite` file to clear a startup error.

### Upgrading notes

- **The dashboard is reachable only on loopback since 1.4.5.** To use it from
  your machine, open an SSH tunnel and browse `http://127.0.0.1:6443`:

  ```bash
  ssh -L 6443:127.0.0.1:6443 user@server
  ```

  For a permanent address, put an HTTPS reverse proxy in front of it on the
  server. nginx example (`/etc/nginx/sites-available/easy-devops-dashboard`):

  ```nginx
  server {
      listen 443 ssl;
      server_name easy-devops.example.com;

      ssl_certificate     /etc/ssl/easy-devops/fullchain.pem;
      ssl_certificate_key /etc/ssl/easy-devops/privkey.pem;

      location / {
          proxy_pass http://127.0.0.1:6443;
          proxy_http_version 1.1;
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-Host $host;
          proxy_set_header X-Forwarded-Proto $scheme;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection "upgrade";
      }
  }
  ```

  The two `X-Forwarded-*` headers are what let a loopback-only dashboard answer
  to a public name; the `Upgrade` headers keep Socket.io working. Remote Hub
  pairing needs `https`.
- **Hub permissions are stricter since 1.4.5.** Certificate paths and raw
  Advanced nginx content need `nginx.config.view`, deployment crash details and
  captured output need `deploy.logs`, and raw Advanced nginx edits need
  `nginx.config.edit`. Revoking a permission now removes the data it protected
  from later telemetry. A Hub that seems to be missing data usually needs the
  grant, not a reinstall.
- **If you updated with `npm` on Windows Server, run `ezz service repair` as
  administrator.** `npm i -g easy-devops` updates only the CLI; the service
  keeps its own copy under `C:\ProgramData\easy-devops\runtime`. 1.4.7 warns
  when the two differ and `ezz service status` shows both versions, but it does
  not repair by itself.

### Known open item

- The nvm release digest is not pinned: the SHA-256 of nvm's `install.sh`
  (`src/lib/installer/nvm-bootstrap.sh`) and the nvm-windows installer digest
  (`install.ps1`) are empty behind a `TODO(owner)` until the owner reviews
  those releases. Until then a fresh Linux server without Node is not given an
  automatic nvm install: the installer prints the exact manual commands, and
  `--keep-node` skips Node management when Node 18+ is already installed. On
  Windows, `install.ps1` offers `winget install --id OpenJS.NodeJS.LTS`.

## [1.4.6] — 2026-11-25

**Not recommended:** the service can fail to start after updating; fixed in
1.4.7.

### Fixed

- Windows Server uninstall shows the active operation and limits every stage to
  five minutes. A stalled stage stops with an error that names the operation
  instead of leaving the CLI waiting indefinitely.
- Windows Server uninstall removes the service account from a preflighted data,
  nginx and SSL tree with one recursive permissions operation instead of
  starting one permissions process per file.
- Keeping Server data during uninstall performs no copy or move and leaves the
  database and Server-mode marker in place. Moving data copies and verifies
  user files only, excludes runtime and wrapper folders, and keeps a backup. A
  copy, verification, activation or deadline failure restores the live source
  before the database is reopened. If Windows blocks a rollback, the error
  names both paths so the data remains recoverable.

## [1.4.5] — 2026-11-25

**Not recommended:** shares the upgrade failure fixed in 1.4.7 — the service
can fail to start after updating, and on Windows an administrator can be
locked out of the service files. Update to 1.4.7, then run
`ezz service recover`.

### Security

- Deployment-generated PM2 configuration, launchers and release metadata are
  published in an engine-owned directory outside the app checkout, using
  exclusive temporary files and atomic replacement. Existing repository links
  cannot redirect those writes.
- Windows ACL grant and revoke operations call `icacls.exe` directly. They are
  limited to approved, canonical, existing directories and refuse links,
  reparse points, system trees, and container roots.
- Windows Server data migration rejects linked, reparse-pointed, and
  non-directory source or destination paths, and hard-linked destination files,
  before copying. A hard-linked source file is only read. The Server mode
  marker is created with exclusive access and atomic replacement, and a linked
  or replaced marker is refused.
- Windows service protection rewrites each directory and file in the approved
  tree one object at a time, locking a directory before enumerating its
  children and never using recursive `icacls /T`. It refuses links, native
  reparse points, and hard-linked files before they can receive a changed ACL.
  The data root grants no read access to `BUILTIN\Users`; only the runtime and
  wrapper folders keep that read/execute grant.
- Windows Server reinstall stops and removes the registered service through
  the Windows service manager before replacing WinSW, so an unreadable or
  replaced wrapper is never executed. An unknown service-query result now
  fails closed instead of being treated as "not installed".
- Windows nginx commands pass paths from settings to PowerShell as literal
  values, so characters such as `$`, backticks, and quotes cannot be evaluated
  as commands.
- Linux nginx error-log views use the bounded log reader with direct process
  arguments instead of interpolating a configured path into a shell command.
- Raw Advanced nginx content requires `nginx.config.edit`. Typed values that
  become nginx configuration reject line breaks, `;`, `{`, and `}` before a
  file is written.
- Backend URLs containing embedded usernames or passwords are rejected before
  they can be written into nginx configuration.
- Changing an app's repository origin clears its stored Git token. A new token
  is required when the replacement repository uses token authentication.
- Site and ACME account private keys are created with mode `0600` in
  directories with mode `0700`. Renewal uses atomic replacement, and renewal
  and service repair correct existing key and directory permissions.
- Authenticated Git fetches receive credentials only through child-process
  `GIT_CONFIG_*` environment variables. Tokens and their encoded forms stay out
  of process arguments and deployment logs.
- The daemon resolves modules only inside its pinned runtime. Admin-owned
  throwing stubs replace optional WebSocket accelerators, and the Windows,
  systemd, and Personal service environments set both `WS_NO_BUFFER_UTIL=1`
  and `WS_NO_UTF_8_VALIDATE=1`. Install, repair, update, and runtime update
  reapply these protections.
- Windows Server install and repair replace the runtime and wrapper folders
  instead of merging into existing content. Optional WebSocket package stubs
  are recreated from admin-owned temporary packages even when an old package or
  link already exists.
- Linux systemd installation stages its unit in a fresh directory with mode
  `0700`, creates the file exclusively with mode `0600`, passes `sudo install`
  direct arguments, and removes the staging directory on every outcome.
- The updater validates the complete version string before stopping a service
  and passes the validated version as a separate process argument.
- Deployment logs and progress now redact each run's secrets before they are
  stored or sent. Unmarked logs from older versions are retired at startup and
  before purge backups, and their free-form diagnostic fields are scrubbed.
- Deployment log reads and retirement use verified child handles and refuse
  links or parent-directory swaps. Deployment roots are kept under the data
  directory, and orphaned deployment logs are retired when their app no longer
  exists.
- Windows installer downloads use a private per-attempt directory, verify the
  expected SHA-256 before launch, and never execute stale or partial files.
  The Linux installer uses bundled, hash-pinned helpers, and its nvm bootstrap
  refuses mutable downloads instead of executing them. Automatic nvm-windows
  installation remains disabled until a reviewed executable digest is
  configured.
- Linux permission setup accepts only the dedicated Easy DevOps SSL and nginx
  configuration roots after checking links, ownership and writable ancestors.
- Certificate issuance, deletion and purge use one cross-process lifecycle
  lock. Removal is limited to files recorded in the managed-artifact manifest,
  is never recursive, and preserves unrelated files, linked paths and unsafe
  roots.
- Lifecycle locks recover safely when an owner PID has been reused. Purging
  preserves the data directory and managed-artifact manifest if certificate
  cleanup cannot finish.
- Deleting a domain with certificate removal enabled retains certificates that
  are shared with another domain or nginx configuration, were not created by
  Easy DevOps, or cannot be removed safely. The response names the reason and
  any remaining configuration references by basename and line.
- Certificate reference checks follow renamed hard links and linked nginx
  configuration directories. Real-path cycle detection prevents repeated or
  looping directory scans.
- Settings refuse an SSL directory that overlaps the data directory, including
  through a linked or canonical path.
- The dashboard listens only on loopback. Remote access goes through a local
  HTTPS reverse proxy or secure tunnel. Passwordless mode is limited to direct
  local requests, proxied sessions use secure cookies, and remote Hub pairing
  requires HTTPS.
- Nginx logs, deployment progress, captured build output, and Windows
  service/supervisor logs have fixed byte and line budgets, so a large file or
  a noisy process cannot make the daemon or dashboard buffer it without a
  limit.
- Concurrent setup-code failures are counted atomically, and a stale attempt
  cannot overwrite a newer setup code. Empty or truncated stale lock files left
  by an interrupted process are recovered instead of blocking setup.
- Hub pairing responses are read through a 16 KiB streaming limit. Malformed or
  conflicting `Content-Length` headers and stalled bodies fail closed.
- Routine Hub telemetry uses explicit monitoring projections. Certificate
  paths and raw Advanced nginx fields require `nginx.config.view`. Deployment
  crash details and captured output require `deploy.logs`. A legacy
  credential-bearing backend host is omitted before transmission.
- Hub permission updates accept only valid boolean grants. Revoking
  `nginx.config.view` clears SSL path data retained by the Hub. Revoking
  `deploy.logs` immediately removes diagnostics from the last deployment
  payload before refreshing process state. Telemetry that was already loading
  is projected again with the current permission state so a late response
  cannot restore protected fields. Delayed Hub mutations, including cold
  imports, PM2 discovery, and an nginx reload after a slow config save, recheck
  the current grant immediately before the side effect. Side-channel events
  and results are checked again, and queued progress is discarded when the
  permission revision changes. Permission-driven telemetry refreshes run
  serially so an older refresh cannot overwrite a newer revocation.
- Hub commands remain bound to the socket connection that dispatched them, so
  re-pairing cannot redirect an in-flight result, progress event, config, log,
  or telemetry payload to the newly paired Hub.
- Hub command permissions now match the exact mutation. Domain delete and
  toggle require their specific mutation permission plus `nginx.reload`, delete
  with certificate removal also requires `ssl.delete`, linking a domain
  requires the app, domain-create, domain-edit, and reload grants plus
  `ssl.issue` when requested, and certificate suggestions require
  `nginx.config.view`.
- Hub certificate paths are omitted from issuance, suggestion, missing-file,
  and linked-domain responses unless `nginx.config.view` is granted. Backend
  URLs containing query strings or fragments are rejected so URL credentials
  cannot be written to nginx configuration.
- Windows service-manager calls use direct executable argument arrays.
- Windows access-control checks use direct executable argument arrays, accept
  approved dedicated Easy DevOps directories beneath `ProgramData`, and refuse
  system trees and container roots.
- Elevated Windows commands start from a clean environment and rebuild machine,
  profile, temporary-directory, and loader values from Windows or the machine
  registry. Caller-supplied paths and loader configuration cannot choose the
  trusted system tools, service locations, or Node startup behavior used after
  UAC. The Windows bootstrap installer also executes its elevated service step
  with an argument array instead of an interpolated PowerShell command string.
- Elevated Windows execution starts in `%SystemRoot%`, canonicalizes the
  selected `node.exe`, requires a valid Authenticode signature, and passes the
  CLI script and arguments as one direct argument array.
- The Windows Server data root is normalized to Administrators ownership before
  the service or installing account receives access. The service gets Modify on
  data and read/execute on runtime and wrapper folders.
- Windows Server repair and status handle an unreadable existing wrapper
  without ending with `EPERM`. Repair restores the running service, and status
  reports individual probe failures as warnings. Access-denied service files
  are reported as unknown rather than as an absent installation. A service
  marked for deletion remains pending until Windows releases its registration,
  and an unresolved service-manager state fails closed.
- Setup code is re-read after acquiring its lock, so a concurrent attempt
  cannot consume stale state or overwrite a newer code.
- Deployment-log retirement covers configured deployment roots outside the data
  directory. It accepts only canonical, non-linked app directories named with a
  valid app id and leaves unrelated files in the operator-selected root alone.
- Dashboard update starts reserve one run before any registry lookup, validate
  the bounded persisted status and dashboard process fields, and use an atomic
  per-run claim so two requests or worker processes cannot launch overlapping
  updates. Reading update status rejects a file that grows beyond the fixed
  bound or changes size after it is opened.

### Upgrading

Run `ezz update` for an npm installation. After updating to 1.4.5, Windows
Server mode users must run `ezz service repair` from an Administrator PowerShell
to apply the service protections. Linux users who saved custom certificate or
nginx paths outside the dedicated Easy DevOps roots must move them back to the
supported locations before running the permissions setup again.

## [1.4.4] — 2026-11-24

**Not recommended: security issues fixed in 1.4.5. Update to 1.4.5.**

### Security

- Deployments protect generated PM2 configuration and release metadata from links in the checkout.
- Windows service permission changes accept only approved existing directories and pass paths directly to the permissions tool.
- Editing raw Advanced nginx settings through the Hub requires `nginx.config.edit`. Structured fields reject characters that could introduce new directives.
- Changing an app’s repository origin clears its saved token. Enter a new token if the new repository requires one.
- Site and ACME account private keys use restricted permissions. Renewal replaces keys atomically, and renewal and service repair correct existing key permissions.
- Git receives deployment credentials in its process environment, keeping them out of command arguments and logs.
- The daemon loads dependencies from its own runtime. Service setup disables optional native WebSocket modules.
- Linux service installation stages the systemd unit in a private temporary directory and cleans up after installation.
- The updater validates the entire version before stopping the service and passes the version as a separate argument.

### Upgrading

Run `ezz update` for an npm installation. After updating to 1.4.4, Windows Server mode
users must run `ezz service repair` from an Administrator PowerShell to apply the new protections.

## [1.4.3] — 2026-11-20

**Not recommended: security issues fixed in 1.4.5. Update to 1.4.5.**

### Added

- The dashboard's app detail now shows a running deployment the way the Hub
  does: the real current stage ("Installing", not a generic "Building") and the
  stage bar Fetch › Settings › Pre › Install › Build › Migrate › Start › Health
  › Post › Finish, with done, current, failed and skipped stages, updated live.
- A stage the app does not use — no pre or post hook, no install, build or
  migrate step, or a disabled one — is shown as skipped, the same way in the
  dashboard and the Hub. The run record now carries `stage` and
  `skippedStages`, and `deploy:progress` sends both; older agents send neither
  and the bar falls back to the run's step.
- The dashboard's app detail has the Hub's Environment tab: variable names,
  values hidden until shown, and Edit through the app's existing form.

- Windows Server mode: commands that need administrator rights (`ezz update`,
  `ezz runtime update`, `ezz service install`, `ezz service uninstall`,
  `ezz service repair`, `ezz uninstall --purge`) check for them before
  changing anything and ask "This needs administrator rights. Relaunch as
  administrator? (Y/n)". Yes opens one elevated PowerShell window (one UAC
  prompt, no password) running the same command with the same arguments; it
  shows its own output and stays open at the end, and the original window
  changes nothing. In a script or CI nothing is relaunched: the command to run
  as administrator is printed and the exit code is 3.
- Windows Server mode: the account that installed the service can start, stop
  and restart it without administrator rights. Install and repair grant that
  account — by SID, never Users or Everyone — start, stop and query on the
  EasyDevOps service and nothing else, plus write access to
  `C:\ProgramData\easy-devops`. `ezz service status` shows it on a "Without
  admin" line. An existing install gets it from one `ezz service repair` run as
  administrator.
- Settings → Update on a Windows Server-mode install no longer starts an update
  the dashboard cannot finish: it says to run `ezz update` from an
  Administrator PowerShell, with a copy button.

### Changed

- Windows Server mode: the runtime and wrapper folders
  (`C:\ProgramData\easy-devops\runtime` and `\bin`) no longer inherit the data
  directory's permissions. They are administrator-only to change, with read and
  execute for the service and for users, so nobody else can replace the
  `node.exe` the service runs.
- `ezz service restart` in Server mode uses the Service Control Manager's stop
  and start instead of the wrapper's restart, so it works for the installing
  account without elevation.

### Fixed

- A custom step no longer sends the stage bar back to Fetch, in the dashboard
  and the Hub.
- Windows Server mode: `ezz hub status`, domain changes and other commands from
  a normal PowerShell crashed with "SqliteError: attempt to write a readonly
  database". The installing account can now write the data, and a database
  that cannot be written prints what to run (`ezz service repair` as
  administrator) instead of a stack trace.
- `ezz update` in Server mode checks for elevation before it stops the
  dashboard or the service, so a normal terminal changes nothing.

## [1.4.2] — 2026-11-20

### Added

- The Hub can issue and delete certificates. The server already offered
  `ssl.issue` and `ssl.delete` under Settings → Hub, but the Hub's SSL page only
  had Renew. It now has New certificate (HTTP-01; DNS-01 and wildcards stay on
  the server's own dashboard, and the Hub says why) with the preflight result,
  the nine live stages, and the failed stage with its cause and fix, plus Delete,
  which is refused while a domain still uses the certificate and names those
  domains.
- The Hub's domain form now matches the dashboard's, including "No certificate
  paths set" and Create certificate. It no longer pre-fills guessed certificate
  paths or claims to "auto-generate certificates if left blank" — it never did.
- Collapsible sections in the dashboard and the Hub open and close with a short
  height animation (instant with reduced motion), and are keyboard and screen
  reader friendly.

### Fixed

- **Security:** the agent's `hub:manageSSL delete` built the directory to
  remove from the name the Hub sent, so a name such as `..` could remove a
  directory outside the certificate folder. It now looks the name up among the
  certificates that exist, like the dashboard always did, and deletes through
  the same check (`core/cert-usage.js`).
- **Security:** `hub:manageDomain create` did no input validation, so the Hub
  could create a domain whose name escaped the nginx config folder. It now runs
  the dashboard's checks, and `update` ignores `configFile`, `enabled` and
  `createdAt` from the Hub.
- A Hub domain saved with SSL on and no certificate on disk failed at
  `nginx -t` with nginx's raw error. The agent now refuses first with
  `cert_missing` and the resolved paths, like the dashboard, and the Hub offers
  Create certificate.
- A refused Hub command now carries its details (the failed stage, the domains
  that use a certificate) instead of only a message. Requires Hub backend 0.2.2
  for quick commands.
- The dashboard's certificate delete also refuses while an enabled domain uses
  the certificate (`usedBy` in the 409), and can delete a certificate folder
  that is unreadable or not yet issued (it answered 404 before).

## [1.4.1] — 2026-11-19

### Fixed

- Windows Server-mode install failed at "Registering the service" with
  "Unable to locate WinSW-x64.[xml|yml]": WinSW v2 only reads a config named
  after its own executable. The wrapper is now stored as EasyDevOps.exe beside
  EasyDevOps.xml, both names come from one constant, a leftover WinSW-x64.exe
  is renamed or removed, an existing registration is removed and re-registered,
  and a failed registration is cleaned up and printed with a hint.
  **If you hit this error on 1.4.0: update, then simply run
  `ezz service install` again.** It reuses the data already moved to
  C:\ProgramData\easy-devops, finishes the install and starts the service; no
  manual steps.
- "migrated; backup at null": the install process had the database open, so
  Windows refused to rename the original to its backup name; the original was
  always kept, the message just did not say where. The database is now closed
  for the move and reopened in the new location (so install details are
  recorded in the live database), and the message names the real backup path,
  or where the original was left. Same fix for moving the data back on
  uninstall. A running dashboard now blocks the move with a message instead of
  racing it.
- After a failed Server-mode install, Server mode stays enabled with the
  migrated data, and running `ezz service install` again resumes from there.
- Windows: commands used `sc`, which in PowerShell is the alias for
  Set-Content, so 1.4.0 wrote stray files named query, qc, stop, start or
  delete (content "EasyDevOps") into the folder the command ran from,
  `ezz service status` showed "Running: no (unknown)" and "Start on boot:
  unknown", and `ezz service stop`/`start` reported success without touching
  the service. Every call now uses sc.exe; the stray files are harmless and
  can be deleted.
- Status asks Windows whether the service exists: a record without a
  registration (sc.exe query: 1060) is reported as such, with "run ezz service
  install"; status agrees with sc.exe query and with the daemon heartbeat.
- The restart count no longer counts the "Starting WinSW in console mode" line
  every command writes; only real process starts count, and a
  stopped-and-restarted service is not called a crash loop (3 unclean restarts
  in 10 minutes are).
- Install waits up to 45 s for the daemon, with progress lines; if the time
  runs out while Windows reports the service running, it says "started, still
  initialising" instead of "Install failed". The install is recorded as soon
  as registration and permissions succeed.
- `ezz service repair` no longer fails with EBUSY on runtime\node.exe while the
  service runs: it stops the service, waits until it has stopped, replaces the
  runtime copy, starts it, and restores the previous copy if the daemon does
  not come up. `ezz update` and `ezz runtime update` also wait for a real stop
  now (their stop used `sc` too).
- `ezz hub status` / `ezz hub connect` in Server mode now show the agent state:
  the CLI could not open the service's named pipe, so the daemon also writes
  its agent state (no secrets) to the data directory.
- Server mode checks elevation for real before copying or migrating anything,
  and stops with "Open PowerShell with Run as administrator and run the command
  again" — no more UAC "Unknown publisher" prompt half way through. When
  elevation cannot be determined, one line first explains the prompt (WinSW,
  verified by SHA-256, not code-signed).
- Elevation messages suggested `ezz service stopping`; they now name the real
  command.

### Changed

- On Windows Server, answering No to "Install in Server mode?" offers Personal
  mode, with a warning: it only runs while you are logged in, signing out of
  RDP stops it (disconnecting keeps it), and it does not start at boot.
  Personal mode is refused, with the steps to move the data back, while the
  machine is already in Server mode.

### Documentation

- A Troubleshooting page
  (https://easy-devops.devxor.team/docs/troubleshooting): logs per mode,
  checking the state, clean stop versus crash, known problems and fixes,
  recovery, and what to send when asking for help. Linked from the service,
  installation and maintenance pages and from the CLI's error messages.

## [1.4.0] — 2026-11-19

### Highlights

- **A native background service.** `ezz service install` registers a systemd
  unit or a Windows service that runs `ezz daemon`; no PM2 for Easy DevOps
  itself, and never a password.
- **The React dashboard is the default UI**, served from the package; the
  classic page stays one flag away (`--classic-ui`).
- **Deployments**: put a Git project on the server with ordered steps, runtime
  cards, preset cards, automatic rollback, live progress, and control from the
  Hub.
- **SSL that checks first**: a preflight stops before Let's Encrypt when DNS,
  IPv6, a redirect or port 80 would fail, and issuing shows live stages.
- **Pair with the Hub from the terminal** with a one-time
  `ezz hub connect <link>`.
- **Security hardening**: a session on every API route, scrypt passwords, a
  one-time setup code, Host/Origin checks, and exactly five fixed sudo rules on
  Linux.

### Upgrading from 1.2/1.3

1.4.0 is the release that gathers this whole cycle, so it carries changes that
need an action or a decision. Nothing below is optional guesswork: each line is
a real behaviour change from 1.2/1.3.

- **The dashboard service is native, not PM2.** `GET /api/service` publishes
  the native service under `backgroundService` (mechanism, installed, running,
  start at boot/logon, pinned runtime, warnings). The top-level `installed`,
  `running` and `enabledOnBoot` fields that described the `ez-dashboard` PM2
  app are **gone**, because on a native-service machine they read "not
  installed" over a working service. A client that read them must read
  `backgroundService` instead.
- **Install the native service once:** `ezz service install`. It runs
  `ezz daemon`, not the dashboard, and removes the old Task Scheduler mode; the
  legacy PM2 app and startup items are offered for cleanup, never touched
  otherwise. `ezz service repair` re-pins the runtime and re-applies permissions.
- **The React dashboard is the default.** The classic EJS page is now the
  fallback: `--classic-ui` for one run, or `dashboardUi: "classic"` for the
  service. A stored `classic` from before this change is migrated to `new`
  once (`dashboardUiMigrated`); after that a deliberate `classic` is kept.
  `--new-ui` is accepted and does nothing.
- **Re-run Settings → Linux permissions on Linux.** The sudoers grant is now
  exactly five fixed `systemctl start|stop|reload|restart|status nginx`
  commands, with no shell, file writer, ownership changer or unit manager. The
  old rules were wider. The setup script also creates and hands over the
  certificate and nginx `conf.d` directories once; issuance no longer calls
  sudo. The dashboard never receives a sudo password — it shows the commands for
  the operator's own terminal.
- **The dashboard API contract is 2.17.x.** It is authoritative for routes and
  Socket.io events and `npm test` enforces the route list. New since 1.2:
  the deploy `steps`/`runtime` fields, SSL `opId` and the per-check `preflight`
  array, `ssl:progress`, `not_issued`/`unreadable` certificate statuses,
  `command:progress` with its optional `domain`, and certificate state on the
  Hub's domain lists.
- **Hub failures are 409/424/422, not 5xx.** An offline agent is
  `409 AGENT_OFFLINE`, no answer within 15 s is `424 AGENT_TIMEOUT`, and the
  agent's own refusal is `422 AGENT_ERROR`; the body keeps `error` and adds
  `code`. The same applies to the CI deploy hook. A result stays collectable
  for 10 minutes. If you wrote a Hub client that expected `502`/`503`/`504`,
  change it.
- **Deploy settings changed shape.** An app can run up to five ordered steps
  (`install`, `build`, `migrate`, `custom`); the old fields are still read
  as the equivalent steps, so old apps keep deploying. Saving with `steps`
  stores the list and drops the old fields, and an app's old fields still win
  over a `steps` list in `ez.json` (with a warning) until they are saved as
  steps. `runtime` is stored per app; only `node` is available and cluster mode
  requires it.
- **Pairing with the Hub rotates the secret.** `ezz hub connect <link>` (and
  the Hub's `cli-link` route) replaces the server's secret and disconnects the
  agent that was using the old one. Re-pair an existing server, and expect the
  old agent to stay offline until the new command has run.
- **Deployments need PM2 and git on the server** (they always did); the
  dashboard does not install PM2. A deploy key app keeps its RSA key until the
  key is regenerated; a new key is ed25519.
- **Certificate status names changed.** `error` is split into `not_issued`
  and `unreadable`; a client that hid dates on `error` can do the same on both,
  but should show "Not issued yet" for the first.
- **The first-run setup needs a one-time code** (`ezz dashboard setup-code`,
  printed to the local terminal only, 6 digits, 24 h, global cap 20). The
  dashboard password minimum is **6** characters, published as
  `minPasswordLength`; no API route is public except the session check, login,
  logout and first-run setup.
- **Windows Server mode stores data in `C:\ProgramData\easy-devops`** for the
  service, CLI and dashboard alike (a service account cannot read the installing
  user's `%APPDATA%`). It is migrated once; uninstall asks and keeps the server
  location by default.
- **The CLI's output is page-based.** A pipe or CI log gets no screen-clearing
  escape bytes; a result waits for Enter only when someone can press it.
- **The Hub's own deployment changed too** if you self-host it: one process only
  (`fork`, `instances: 1`), `TRUST_PROXY` decides the client address,
  `request-ip` is gone, JSON bodies are capped at 256 kB, and SSL, deploy and
  config commands are relayed with their results kept for 10 minutes.

### Added

#### Deployments: ordered steps, runtimes and presets
A deployment is no longer three fixed commands. `settings.steps` is an
ordered list of at most five steps, each `{ run, kind, enabled? }`, and the app
form edits it directly.

- **Every kind is a step.** `install`, `build`, `migrate` and `custom` run
  in list order in the new release, before the switch. A disabled step is
  skipped and logged. A non-zero exit stops at that step and leaves the running
  release untouched; the run record's `step` is the kind, or `step N` for a
  custom one.
- **Order warnings, not errors.** `migrate` before `install`, `build` before
  `install`, or `migrate` before `build` is reported as a warning naming the
  step to move (disabled steps do not count). Nothing is refused.
- **Every app records a runtime.** `runtime: "node"` is the only selectable
  value and the default; Python, Go and a static site appear on the same card
  row, disabled and marked **Coming soon**, so the plan is visible. Cluster mode
  requires `node`.
- **Presets are cards.** Under the Node.js card, Default Node app, Next.js,
  NestJS, Express/Fastify and Nuxt each show as a card with a one-line command
  summary (`npm ci → npm run build → npm start`), plus a **Custom** card that
  starts from empty steps. No brand logos. The cards are a radio group (arrow
  keys, Space). A preset asks before replacing steps the operator edited, and
  never starts a deployment; after an edit the form says, for example,
  **Modified from Next.js** with **Reset to preset**.
- **Reordering steps is visible.** The dragged step follows the pointer as a
  lifted copy, a dashed placeholder marks where it will land, and the other
  steps slide out of the way; vertical only, with auto-scroll inside the form.
  Mouse, touch and keyboard (Space to pick up, arrows to move, Space to drop,
  Escape to cancel) all work, each move is announced to screen readers, the
  move up/down buttons stay, and reduced motion turns the animation off. Each
  row has its own error and the API's order warnings are shown beside the list.
- **An inherited list is not guessed at.** The API returns the app's overrides,
  not the resolved `ez.json` list, so the form shows a read-only
  **inherited from ez.json** panel and an **Override steps** button.
- Contract 2.15.0. `e2e/deploy-steps.test.mjs` covers the list, the legacy
  fields, the precedence and the warnings.

#### Notifications: one channel picker in every form
The app form's **Notify on every deployment** list and the domain form's
per-event channel lists, in the dashboard and in the Hub, are now one channel
picker. What is saved is unchanged.

- **Channels are cards.** Each shows its name, a type badge with its own colour
  in both themes (Discord, Telegram) and, when known, whether its last test
  passed or failed. A check marks the selected ones.
- **Select all, Clear and a count** (`2 of 3 selected`); a search field appears
  once there are more than six channels. With none, the picker says **No
  notification channels yet** and links to the Notifications page.
- **Events are toggle rows.** A domain's events sit under a group toggle that
  shows all, none or some.
- **In the Hub**, a channel the server does not let you change stays visible,
  disabled, with the reason.
- Keyboard and screen-reader accessible, and usable at 375 px.

#### SSL: a preflight, live stages and an honest certificate list
Issuance now proves it can succeed before it asks Let's Encrypt, reports each
stage while it runs, and stops calling a never-issued certificate an error.

- **A preflight before any ACME request.** `core/ssl/preflight.js` checks DNS
  for every name (including `www`), an IPv6 address that points elsewhere, the
  public HTTP challenge path through nginx, and Cloudflare's role. A failed
  check stops with `step: "preflight"`, the real cause and a one-line fix, so
  no account, order or failed validation exists and no rate limit is spent.
  DNS-01 reports the IPv6/HTTP checks as `skipped`; standalone mode skips the
  public probe because it binds port 80 itself.
- **The same nine stages everywhere.** `preflight` → `account and order` →
  `challenge ready` → `waiting for validation` → `certificate received` →
  `files written` → `nginx config test` → `nginx reload` →
  `https verified`. `core/ssl/progress.js` owns the vocabulary and the
  throttled, sanitized payload (PEM blocks stripped, 300 characters at most);
  the dashboard publishes `ssl:progress`, the CLI renders the same list, and
  the Hub receives `command:progress`.
- **A five-minute bound.** A run that runs out of time fails naming the stage it
  was in rather than leaving the request open.
- **An honest list.** `GET /api/ssl` now separates `not_issued` (a directory
  with no certificate yet — label "Not issued yet") from `unreadable`
  (`fullchain.pem` exists but cannot be parsed), instead of a single `error`
  that made a domain whose certificate had not been requested look broken.
- **Linking a domain reports the same stages.** `domain`, the certificate
  stages, then `https`, `nginx config test`, `nginx reload` and
  `https verified`; an existing certificate skips the issuer stages and an SSL-off
  link reports `https: skipped` while still testing and reloading nginx.
- **The checks come back with the answer.** The dashboard's issue, renew and
  renew-all responses carry a `preflight` array of
  `{ id, status, message, fix }` — on success as well as failure — and `null`
  only when the request stopped before the checks ran. A failed result is shown
  with its one-line fix.
- **Linking a domain is live too.** `PUT /api/deployments/:id/domain` takes an
  optional `opId` and publishes `ssl:progress` with the linked name, so the link
  dialog shows the same stage list while it runs; a failed link is reported once,
  with its cause and what to do next.
- **The Hub names the domain.** SSL `command:progress` frames carry an optional
  `domain`, so `renewAll` shows each domain's stages in turn; Hub domain lists
  carry `certStatus`/`certLabel`, and a never-issued certificate reads
  "Not issued yet" — an unreadable one "Expiry unknown" — instead of a blank
  date.
- Contract 2.16.0, extended 2.17.0. `e2e/ssl-preflight.test.mjs` covers every
  check and its fix, the DNS-01 skips, and that a failed preflight never reaches
  the ACME client.

#### Pairing from the terminal, and a cleaner CLI
The Hub can now hand its connection string to the server's own terminal, and
the CLI draws one page at a time.

- **`ezz hub connect <link>`** consumes a one-time link from the Hub's
  **From the CLI** pairing option, saves the pairing and waits (bounded at 30 s)
  for the daemon's `hub:agentState` before saying connected. `ezz hub status`
  shows the Hub origin, server id, granted permissions and agent state, and
  `ezz hub unlink [--yes]` removes the local link. All three are also in the
  interactive Hub menu.
- **The link is a credential.** `core/hubConnect.js` accepts https only (plain
  http for loopback), refuses redirects, bounds the request at 15 s and 16 KiB,
  and never prints or returns the token or the connection string. A link lasts
  **5 minutes**, works **once**, and is replaced by a newer one; expired, used,
  replaced and revoked are distinct answers.
- **Creating a link rotates the secret** and disconnects the agent using the old
  one, which is why the Hub warns before doing it to an already-linked server.
- **Every CLI pairing command confirms on a previously paired server**, not only
  the first time: each one gives the server a new secret and leaves it
  disconnected until the command runs.
- **The Hub offers both pairing methods.** Add server has **From the
  dashboard** and **From the CLI** tabs. The CLI tab shows the command with a
  five-minute countdown, a **Copy** button, and the real **Connected** state
  once the server reports; the command lives only in component state.
- **Clean CLI pages.** `src/cli/ui/page.js` prints an
  `Easy DevOps > …` breadcrumb, clears the previous page where that is safe,
  and gives every sub-menu one `← Back` and the main menu one `✖ Exit`.
  Clearing is skipped when stdout is not a TTY, when `CI` is set and in a
  captured test run, so a pipe or CI log gets plain lines and no escape bytes.
  `pause()` holds a result until Enter and returns at once when nobody can
  press it.
- `e2e/hub-connect-cli.test.mjs` covers the link, re-pairing, the error
  codes and the redaction; `e2e/cli-pages.test.mjs` covers the breadcrumb, the
  clear decision, Enter-to-continue and piped output.

#### Update Easy DevOps from the dashboard
Settings → Update works from the browser, with the same `core/updater.js` flow
as `ezz update` and the same refusals. The request cannot do the work itself —
npm replaces the files the server is running from, and that server is stopped
mid-way — so it records the run and starts a detached worker that outlives it.

- **`GET /api/update`** — registry check, install source (`npm`, `clone` or
  `unknown`) and the last run. **`GET /api/update/status`** is the run record
  alone: no registry call, so it is what a client polls while the dashboard is
  going down and coming back. **`POST /api/update`** takes an optional
  `{ version }` and answers `202 { started, run }`; the outcome is only ever in
  the run record.
- **A git clone or loose copy is refused** (`409`, with `source`), because
  `npm install -g` would install a second copy and leave the service running
  the clone. A run already in flight is refused too, and a registry that cannot
  be reached is `502` rather than a guess.
- **The worker survives the restart it causes**: it stops the dashboard, runs
  the identical update, starts the dashboard again on the port the request
  actually arrived on, and leaves phases (`starting` → `stopping` → `updating` →
  `restarting` → `done`/`failed`) in `core/updateStatus.js`. An active run whose
  worker is gone and whose heartbeat is older than 45 s is reported as
  `interrupted`, never as still running, so a crashed worker cannot leave a page
  polling for ever. The file is `update-status.json` in the data directory,
  written atomically, and survives a failed rollback.
- **Settings → Update renders the run after the restart**, including `step` and
  `reason` on a failure and whether the previous version was reinstalled.
- Contract 2.10.0. `e2e/dashboard-update.test.mjs` covers the endpoints and the
  guard rails; `e2e/updater.test.mjs` covers the update itself.

#### Deployments: persistent paths
A project can now keep data across releases without copying it. `settings.persist`
lists project-relative folders — or single files, such as `prisma/hub.db` — and
each lives once in `<app dir>/shared/<path>` and is linked into every release at
the same path, so an upload, a SQLite database or a generated cache is never
replaced by a deploy.

- **Enabling it on an app that already ran seeds from its live release**, so data
  written before the setting existed is not lost. A path already in the shared
  area wins; a new one is seeded from the live release and then the checkout for
  a folder (a file the other way round), and created empty when neither has it.
- **The kind is decided from evidence, not the name** where possible, and only
  then from the last segment — a dot means a file.
- **On Windows without the symlink privilege** folders become junctions and files
  hard links; the link is verified after the build.
- **A build that replaces a link with a real file or folder fails the deployment
  at the `build` step**, rather than silently deploying with data that will
  vanish on the next release.
- Paths are validated in `core/deploy/ezfile.js`: relative, no `.` or `..`, not
  `.git` or `node_modules`, at most 20, no case-insensitive overlap.
- `apps[]` and `GET /api/deployments/:id` expose `sharedDir` and
  `hasSharedData`; `DELETE /api/deployments/:id` keeps the shared area unless
  `purgeData` is asked for. Contract 2.8.0.

#### Certificates: delete, and a suggestion before issuing
- **Delete a certificate from the SSL page.** `DELETE /api/ssl/:domain` removes
  the certificate's directory — after scanning the whole nginx config tree,
  including the main `nginx.conf` and `.conf.disabled` files, for anything that
  points into it. If a config still references it the answer is `409
  cert_in_use` with the file, line and text of every reference and nothing is
  deleted, which is what keeps nginx from being left pointing at missing files.
  Deleting a domain can do it in the same step with `?deleteCert=true`.
- **A suggestion instead of a blind issuance.** `GET
  /api/domains/:name/ssl-suggestion` looks for an existing certificate that
  already covers the name — an exact directory, a SAN entry, or a wildcard
  covering one label — and offers its paths and expiry. It changes nothing; the
  UI fills the paths only when the operator accepts. `e2e/ssl-suggest.test.mjs`.

#### Deployments: migrations, boot-crash detection and cluster mode
Three additions to what a deployment does with a release that is not obviously
healthy, and what it reports afterwards.

- **`migrate`** — a command, a list, or `false` to skip — runs in the new release
  directory after `build` and before `start`, with the build's environment. It is
  also read from `ez.json`. A non-zero exit fails the run at the `migrate` step
  before anything running is touched, and the previous release keeps running.
  Migrations are **forward-only**: rolling the code back cannot undo one, so keep
  each migration backward-compatible for one release.
- **A release that crashes at boot is caught, not just one failed HTTP probe.**
  A worker PM2 reports as errored or stopped, or one that keeps restarting over
  the confirmation window, fails the deployment even when a probe answered once;
  in cluster mode every worker is watched. The previous release is started again
  automatically.
- **The run records why.** `reason` carries a short explanation such as
  `crashed at boot: restarting 3 times`, `logTail` the last 40 lines of the
  crashed release's PM2 log with every environment value replaced by `***`, and
  `rollbackSucceeded` whether the previous release came back healthy (`null` when
  no rollback was attempted — a first release, or `autoRollback: false`). The
  dashboard shows them as a rollback report on the failed run.
- **Cluster mode.** `execMode: "cluster"` runs one worker per `instances` (a whole
  number from 1 to the CPU count, or `"max"`). A deployment of an app already
  running in cluster mode uses `pm2 reload` instead of delete-and-start, so the
  new workers start before the old ones stop. Cluster mode needs a direct
  `node <file>` start command; `instances` above 1 with `fork` is refused, and
  the app is warned that it must be stateless.
- `apps[]` and `GET /api/deployments/:id` report `execMode`, `instances` and
  `instancesOnline`, so the dashboard shows `Cluster · 3/4 online` (and `0` when
  PM2 is not running) instead of assuming every configured worker is up.
- Contract 2.11.0. `e2e/deploy-safety.test.mjs` covers `migrate` and the
  boot-crash report; `e2e/deploy-cluster.test.mjs` covers the validation rules,
  the reload and the per-worker health check.

#### Hub commands answer in the HTTP request
A quick command — reading or saving a config, logs, deploy list/detail, an SSL
suggestion, a PM2 action — is now answered by the dispatch request itself. The
Hub sends it with a socket.io acknowledgement and waits up to **15 s**, so a page
whose socket has not finished subscribing no longer misses the event and spins
for ever.

- **Long commands** (deploy, rollback, certificate issue/renew, nginx
  start/stop/restart) still answer `202` immediately and keep running; their live
  `command:result` events are unchanged.
- **A result stays collectable.** `GET /servers/:id/commands/:requestId` returns
  it for the server's owner for 10 minutes from completion, capped at 500
  entries and evicted oldest-first. A page reload, or a browser that was never
  subscribed, can collect a long command's answer. Another user's or server's id
  is `404`, so an id cannot be probed.
- **The failure is named.** `409 AGENT_OFFLINE`, `424 AGENT_TIMEOUT` (naming the
  command and the 15 s) and `422 AGENT_ERROR` carrying the server's own message,
  instead of a generic "no response from the server". The body keeps `error`
  and adds `code`, and none of them is a 5xx.
- **The agent logs each command's duration and outcome** —
  `[hubAgent] hub:getConfigs 34ms ok` — and never its payload, which can carry
  environment values, config contents and deploy tokens. It is how a cold first
  run is told apart from a Hub-side timeout.
- **The Hub's deployment panel no longer polls a command every 8 s.** The app
  list is pushed when a run starts or ends, Refresh re-reads the details and the
  run log, and returning to a background tab does one fresh read.

#### Deploy keys in one step
Creating a deploy-key app can now generate its key in the same step, and the
key can be proved and installed without leaving the App form. The private half
never leaves the server: every response carries only the public key, its
fingerprint and where to add it.

- **"Generate a deploy key for me" is on by default** when the repository
  access is a deploy key. The app is still created **without a deployment**,
  and the response has `deployKey: { publicKey, fingerprint, createdAt, addUrl }`
  — `addUrl` is the repository's GitHub "Add deploy key" page. A generation
  failure leaves the app in place with `deployKeyError`, and "Regenerate key"
  is still offered.
- **The key is ed25519**, written in the app folder as `id_deploy` with mode
  `600` (the data directory's ACL on Windows). An app created before this keeps
  its RSA key and keeps working until the key is regenerated.
- **Test connection** runs `git ls-remote --heads` with the app's key and
  GitHub's **pinned** host keys (`StrictHostKeyChecking=yes`, never
  `accept-new`), with a 12-second bound inside the Hub's 15-second quick-command
  window. A wrong key, a changed host key, DNS or port 22, and a missing git
  each get their own reason and next step. Another SSH host is refused by the
  test, and a deploy to one keeps `accept-new`.
- **"Add it to GitHub for me"** takes a token typed for that request, used once
  and not stored. It adds the key **read-only** and removes an older key with
  the same title only after the current one is on the repository. A GitHub
  refusal is reported per step.
- **Regenerate key** replaces the private half, so the old key stops working on
  this server at once; it is refused while a deployment is running. GitHub
  still lists the old public key until it is removed, which is why the previous
  fingerprint is returned.
- All of it is also a Hub command (`regenerateKey`, `testKey`,
  `addKeyToGithub`) under `deploy.manage`. Contract 2.13.0.

#### Link a domain with SSL
Linking an app to a domain can now choose the certificate in the same step,
with the same validation and nginx output as the Add-domain page.

- **Name and `www`**, an SSL choice of **new** (HTTP-01, also covering `www`),
  **existing** from the server's suggestion (wildcards included) or **none**,
  an HTTP→HTTPS redirect that defaults on whenever SSL is used, and the
  **Behind Cloudflare** option.
- **A new wildcard is refused**: DNS-01 is out of scope here. Issue the
  wildcard from the SSL page, then link the app to it with an existing
  certificate.
- **A new certificate is issued over HTTP-01.** The link is applied first, so a
  failed issuance still leaves the domain working over HTTP and the result says
  why. The dashboard answers when issuance finishes; from the Hub it is a long
  command with a stored result, and the dialog shows each stage live —
  `domain`, the certificate stages `preflight` → `account and order` →
  `challenge ready` → `waiting for validation` → `certificate received` →
  `files written`, then `https`, `nginx config test`, `nginx reload` and
  `https verified` — through `command:progress`.
- **Existing certificate paths only ever come from the server's own
  suggestion**; a `certPath`/`keyPath` from the caller is ignored, and a name
  that does not cover the domain(s) is refused before anything is written.
- The Hub needs `deploy.manage` and `domains.create` to link, plus `ssl.issue`
  to issue a new certificate. Contract 2.12.0.

#### Live deployment progress through the Hub
A deployment now streams its current step — and, with `deploy.logs`, its new
log lines — to the Hub's run view while it runs, wherever it was started: the
Hub, the local dashboard, `ezz daemon` or a CI hook.

- The agent reads the same deploy lock, run record and log file the engine
  writes, so a run started in another process is visible too. At most one event
  per run per second; one event carries at most 200 lines and 32 KiB (each line
  capped at 2000 characters), with `skipped` counting the newest-kept overflow.
- Every line is redacted with the app's own environment values and token before
  it leaves, and PEM private-key blocks are dropped from BEGIN to END.
- The Hub relays it to the browser and **stores nothing**. The stored run from
  `hub:manageDeploy { action: "run" }` is still the source of truth once the
  deployment ends. Contract 2.13.0.

#### The Hub's server page is the dashboard's
Inside a server, the Hub now uses the dashboard's sections, in its order, with
the same names, icons and structure: Overview, Domains, SSL certificates,
Nginx, Deployments, Notifications, Processes, Logs and Settings. The server
list and switcher, the identity row with one overflow menu (rename, regenerate
secret, remove), permissions, account and management sit around that inner
view. A screen with no Hub command yet is read-only and says **"Managed on the
server"** instead of offering a control that cannot work.

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
  managing apps does not imply managing domains. This first version linked
  over HTTP only; the later link-with-SSL change added the certificate choice
  under `ssl.issue`.

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
  asked, and are not stored by the Hub. A deploy key generated from the Hub is
  generated on the server; only its public half and fingerprint are returned
  (see "Deploy keys in one step").
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

**What the first version did not have, and what changed later in this cycle:**
zero-downtime switching (cluster mode reloads instead of restarting), creating
the GitHub secrets through GitHub's API (the libsodium dependency was taken —
see "Deployments from the Hub"), and triggering deployments from the Hub (now
supported). Serving a static site straight from nginx is still not offered; it
runs as a process like any other app.

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
- The output explains the constraint — the process that performs the update is
  the one being stopped and replaced, so it cannot report from inside the
  request. Settings → Update therefore records the run and hands it to a
  detached worker (see "Update Easy DevOps from the dashboard" above); the Hub
  can still only explain why it does not offer it.

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

#### Superseded during this cycle
Two features were added earlier in this cycle and then replaced before release.
The **dashboard UI behind a flag** (`--new-ui`) became the default: the React
dashboard in `dist/ui` is served unless `dashboardUi: "classic"` or
`--classic-ui` asks for the old page, and `--new-ui` is accepted and does
nothing (see "The React dashboard is now the default UI" under **Changed**).
The **background service via PM2** (`ez-dashboard`, `pm2 startup`, the Task
Scheduler mode that needed a Windows password) was replaced by a native OS
service running `ezz daemon` — see "A native OS service, and never a password
again"; `core/service/legacy.js` only finds and offers to remove the old
setup. What stays from that work is PM2 for the user's own apps: the
**Processes** page lists every PM2 app (status, CPU, memory, uptime, restarts)
with start, stop, restart and logs, asks before touching an app Easy DevOps did
not create, and the Hub shows the same list, acting on it only with
`process.start`, `process.stop` and `process.restart`.

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

### Changed

#### Deploy settings: steps win, old fields still deploy
The three command fields remain readable, so an existing app or `ez.json`
deploys exactly as before — each field becomes the equivalent step. Precedence
is by layer: the first layer that states `steps` wins the whole list, but a
higher layer's old fields still win over a lower layer's list (the app's
commands over `ez.json`), and the response says so. Saving settings that carry
`steps` stores them and removes the old fields. A skipped old field (`false`
or an empty list) becomes an omitted step; the new format uses
`enabled: false`. Contract 2.15.0.

#### The Hub reports SSL progress on `command:progress`
`hub:manageSSL` `issue`, `renew` and `renewAll` now emit live progress in
the same nine stages the dashboard shows, correlated by the command's existing
`requestId` — no field was added to the command or its result. `renewAll`
reports each domain in turn under that one id, and the optional `domain` on a
frame says which name a stage belongs to. The Hub relays a frame only while
the command is pending for that server and stores nothing; the stored result is
still the outcome. Contract 2.16.0, extended 2.17.0.

#### App settings pass through the Hub verbatim
`hub:manageDeploy` `create` and `update` carry the app's `settings` exactly
as the server's own dashboard sends it, including `steps` and `runtime`. The
Hub neither rewrites a command, adds a step nor resolves precedence; the agent
validates it with the same `core/deploy/ezfile.js` functions and returns the
same public app view. `env` remains the one field excluded from those actions.

#### Hub agent failures use non-5xx statuses
An offline agent is `409 AGENT_OFFLINE`, one that does not answer within 15 s is
`424 AGENT_TIMEOUT`, and an agent refusal is `422 AGENT_ERROR` — for commands
**and** the CI deploy hook. The body keeps `error` and adds `code`. This is
deliberate: the Hub sits behind Cloudflare, which may replace an origin 5xx page
and hide the agent's reason.

#### `request-ip` removed from the Hub
The Hub takes the client address from Express's `req.ip` under `TRUST_PROXY`;
the `request-ip` package and its types are gone.

#### Dashboard UI fixes
- **PM2 shows "Checking…"** instead of "Not installed" while its detection probe
  has never completed. `GET /api/service` says so with `probes.pending`, and the
  Settings/Processes panels render the three states apart.
- **Probes are visible while they are measured.** A page that arrives before the
  cached probes are warm re-fetches once shortly afterwards instead of blocking
  the first render, and says "Measuring…" / "Refreshing…" where a measured value
  is not in yet.
- **The interface is a setting in the dashboard again.** Settings → General has
  the `new` / `classic` control with the honest hint that it applies on the next
  start, and `GET` and `POST /api/settings` now resolve the same value through
  one helper, so a config `GET` reads as `classic` can never be echoed back as
  something else.
- **The Hub panel follows `hub:agentState`** instead of polling. The agent is
  often in the background service, so a page that only polled could sit on
  "Connecting…" through a reconnect or a stop; it now reflects every real state
  transition as it happens.
- **A `429` says how long to wait, and the form counts it down.** The login and
  first-run forms show "Try again in 2 minutes" from `retryAfterSeconds` (and the
  `Retry-After` header) and disable the button until it reaches zero, instead of
  inviting a retry that cannot work.
- **No sudo password field anywhere.** Settings → Linux permissions in both UIs
  asks the server for the setup commands and shows them to copy; it never
  collects, sends or stores a password. The classic page and the React page do
  the same thing through the same endpoint.
- **`Settings → Linux permissions` can be re-checked** without re-generating the
  commands, and says plainly when the rules are still missing.
- **The "dashboard did not come back" hint names a real command.** It said
  `ezz dashboard`, which issues a first-run setup code rather than starting the
  server; after a failed restart it now says `ezz --dash`, which is what actually
  starts the dashboard in that terminal.
- **The Dashboard CLI menu explains first-run setup** (`ezz --dash`): it names
  the one-time setup code and `ezz dashboard setup-code` instead of the old
  "admin" login, and gains a "How to use" entry.

#### nginx: WebSocket-ready domains, and an option for Cloudflare
- **Every proxied domain can now carry a WebSocket.** Generated configs send
  `proxy_http_version 1.1`, `Upgrade $http_upgrade` and
  `Connection $ezz_connection_upgrade`. The map behind that variable is written
  once to `00-easy-devops-websocket.conf` in `conf.d`, because the `http` context
  may define it only once and a second copy fails `nginx -t`. A plain request
  sends no `Connection` header at all, so upstream keep-alive is preserved.
- **`/socket.io/` is proxied unbuffered** (`proxy_buffering off`, one-hour read
  and send timeouts) while ordinary HTTP keeps the domain's read timeout.
- **"Behind Cloudflare" is a per-domain option.** When `behindCloudflare` is on,
  the server block adds `set_real_ip_from` for every published Cloudflare IPv4
  and IPv6 range plus `real_ip_header CF-Connecting-IP`. It is off by default, and
  a domain saved before it existed generates the same output as before apart from
  the WebSocket headers. The ranges live in `src/core/cloudflare-ips.js`; refresh
  them with `node scripts/refresh-cloudflare-ips.mjs`.
- **It trusts the header, it does not hide the origin.** The application behind
  nginx must trust exactly one proxy (the Hub: `TRUST_PROXY=1`), and direct
  access to ports 80/443 has to be limited to Cloudflare's ranges at the
  firewall. Without that, anyone who knows the origin address can still connect
  and send their own `CF-Connecting-IP`. See `docs/nginx-websocket-cloudflare.md`.

#### Hub: rate limits follow the real client, and only through a trusted proxy
- **`TRUST_PROXY` unset trusts only a loopback proxy**, which is the nginx on the
  same machine. A caller can no longer choose its own login or request bucket by
  sending `X-Forwarded-For`; `TRUST_PROXY=<n>` trusts exactly n hops (1 behind
  Cloudflare with the option above, 2 without nginx `real_ip`).
- **Sign-in counts failed attempts only**, so people who share an office or proxy
  address do not lock each other out by signing in successfully. The password
  change, password reset and account deletion routes keep their own budget.
- **A `429` is distinct from a wrong email or password.** It answers
  `code: "RATE_LIMITED"` with `retryAfterSeconds` and a `Retry-After` header, and
  the Hub shows "Try again in …" with the button disabled until the countdown
  ends, rather than inviting a retry that cannot work.

#### The Hub runs as exactly one process
PM2 cluster mode, `instances` above 1, or any worker id other than 0 now stops
the Hub at boot with the reason. Every agent socket and every pending command
request lives in memory in one process: a second instance would own a different
set of sockets, split agents between instances, and silently lose commands sent
to the other process. Run it as `exec_mode: "fork"`, `instances: 1`, and do not
`pm2 scale` it.

The Hub's own `ez.json` deploys it with the same engine: `prisma migrate deploy`
runs in the `migrate` step, after `build` and before the new release starts, and
`DATABASE_URL` points at an absolute `file:` path in a persistent folder outside
the release directories. A database inside a release is replaced by the next
deployment.

#### Hub build: a type check that cannot emit
`tsconfig.json` is **type-check only** (`noEmit`), `tsconfig.build.json` is the one
config that emits — into `dist/`, with test files excluded — and `npm run dev`
watches that config and restarts on a successful build. `src/**/*.js` is ignored
so a stray compiled file cannot sit next to its `.ts` and shadow it.

#### The service API, and background work moves to core/jobs
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

#### Hub permission gates and the server page
- **Sudoers rules are narrower** — exactly five fixed `systemctl … nginx`
  commands, and the dashboard never receives the password. The rules, what was
  removed and why, and the re-run instruction are under **Security** above.
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

#### Constitution and CLAUDE.md
- **Constitution amended to 2.0.0** (`.specify/memory/constitution.md`). MAJOR,
  per its own Governance rules, because two existing rules are incompatibly
  redefined: Principle III ("No Build Step", frontend from a CDN) now permits a
  dashboard UI build step while *prohibiting* runtime CDN loading, and the
  Development Workflow's "no test suite … do not add a test framework" is
  replaced by required plain-Node e2e suites with `npm test` passing before
  release. Two principles were added: **VII. Test Isolation** (enforced in code,
  not convention) and **VIII. Simplicity and Zero Configuration** (measured by
  the time from install to a first domain on HTTPS).
- **`CLAUDE.md` now carries the hard rules** as a 30-rule summary, because
  spec-kit is no longer used day to day and the constitution was not being read.
  The two must be updated together.

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

#### Compatibility
- **Servers already linked keep working with no action required.** The stored `hub-link` and
  `hub-permissions` shapes are unchanged; only the way a link is first established has changed.

### Removed

- **The PM2 install path for Easy DevOps itself.** `core/service.js` and the `ez-dashboard` app it
  created are gone; the native OS service is the only way it runs in the background. `core/runner.js`
  keeps the old names only to recognise a leftover app and offer to remove it.
- **The Windows Task Scheduler service mode**, which needed the user's Windows password. The native
  Windows service runs as a virtual account with no password; uninstall still offers to remove what
  the old mode left behind.
- **`request-ip` in the Hub.** The client address is `req.ip` under `TRUST_PROXY`; the package and
  its types are gone.
- **The separate install/build/migrate fields in the app forms.** The API still accepts them and reads
  them as steps, but the dashboard and the Hub edit one ordered steps list; saving that list drops
  the old fields from the app.
- **`POST /api/hub/generate-link`.** The Hub issues the connection string; the server consumes it.
- **The PM2-era top-level `installed`, `running` and `enabledOnBoot` fields of `GET /api/service`**,
  replaced by `backgroundService`. A client that read them saw "not installed" over a working service.

### Fixed

#### A step's switch shows its real state
Every step row read "Step N enabled" even with its switch off. The switch now
says **On** or **Off**, its accessible name follows the state, and a disabled
step is dimmed and marked **Skipped**, in the dashboard and the Hub.

#### Nested dialogs, and SSL progress through the Hub
- **The Hub no longer drops SSL stage progress.** Its `command:progress` validator rejected stage
  names containing spaces (`waiting for validation`, `nginx config test`), so a Hub-run issue or
  renewal stayed silent between dispatch and result. Kebab ids and lower-case words separated by
  single spaces are accepted; anything else is still refused.
- **Dialogs close one at a time.** Only the topmost dialog handles Escape, so pressing Escape in a
  confirmation no longer closes the form underneath it.
- **A pairing request cannot be dismissed mid-flight.** The Hub's pairing dialog stays open while a
  secret or a CLI command is being created, so its outcome is not lost behind a closed dialog.

#### A certificate that was never issued no longer reads as an error
A certificate directory with no certificate file is `not_issued` with the label
"Not issued yet"; only a `fullchain.pem` that neither Node nor openssl can parse
is `unreadable`. The list shows both without inventing a date, and actions that
need a usable certificate still skip them.

#### The test runner, cache policy and installer checks
- **`npm test` runs the suites again.** The script had been renamed to `testold`,
  so the command every contributor types and `prepublishOnly` depends on did
  nothing. `npm test` and `npm run test:e2e` are now the same runner.
- **A rebuilt dashboard bundle could be served from cache for a year.**
  `index.html` — and anything else in the build without a content hash — is
  `no-cache` now; only a Vite-hashed asset is `immutable`. Requesting
  `/index.html` by name gets the same policy as the SPA fallback.
- **`install.bat` now requires Windows PowerShell 5.1, not "major version 5".**
  It compared only the major number, so PowerShell 5.0 passed a check whose whole
  purpose was to refuse it, and `install.ps1` then failed somewhere less
  explicable. The comparison is major*100+minor, and the failure names Windows
  Management Framework 5.1 as the thing to install.

#### Renewal names, nginx reload and Hub health
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

#### Service status speed, and installer and PM2 fixes
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

#### Other fixes in this cycle
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

#### Dashboard shutdown, logs and the data directory
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

### Security

#### CLI pairing links are one-time, short-lived credentials
A pairing link's path is the credential: it is https only (loopback may use
http), redirects are refused rather than followed, the request is bounded at
15 s and 16 KiB, and the Hub stores the connection string in memory behind a
SHA-256-keyed token that expires after 5 minutes and is consumed on first use.
Creating one rotates the server's secret and disconnects the live agent; a used
link leaves a short tombstone that says why instead of a lookup that could
distinguish near-misses. The Hub redacts the whole `/connect/cli/<token>`
segment from every logged URL, and the CLI prints only the Hub origin and the
server id — never the token or the string. `e2e/hub-connect-cli.test.mjs`
asserts that no output carries a secret.

#### Credentials, sudo and destructive operations
- **A deploy key's private half never leaves the server.** It is written only
  to `<app>/id_deploy` with owner-only permissions and is not returned by any
  endpoint, log, event or Hub payload. Live progress and the Hub's stored run
  log drop PEM private-key blocks, and redact the app's environment values and
  token before a line is sent. A GitHub connection is verified against GitHub's
  published host keys (`StrictHostKeyChecking=yes`, never `accept-new`), both in
  "Test connection" and in the fetch during a deployment. A token typed for
  "Add it to GitHub for me" is used once and not stored.
- **The dashboard never receives a sudo password.** `POST
  /api/settings/permissions/setup` takes no body (a `password` from an older
  client is ignored, never read), runs nothing privileged, and answers with the
  exact terminal commands. The operator runs them where sudo asks **them** for
  the password. That is the only place it is typed.
- **The sudoers grant is exactly five commands.** `core/permissions.js` is the
  single source: `systemctl start|stop|reload|restart|status nginx` with the full
  `/usr/bin/systemctl`, no wildcards, and nothing else. The bare `/usr/bin/systemctl`,
  the unrestricted nginx binary, `certbot`, `mkdir`, `cp`, `chmod`, `chown` and
  `tee` grants are gone — each was a root shell on its own. Directories that
  used to need `sudo mkdir`/`sudo chown` at runtime (the certificate directory,
  nginx `conf.d`) are created and handed over once by the same setup script, and
  certificate issuance no longer calls sudo at all. **Re-run Settings → Linux
  permissions on existing servers**; the old rules were wider.
- **`cleanup apply()` confines every delete.** An item id is re-checked against
  the real path before anything is removed: it must be strictly inside the data
  directory, the nginx directory or PM2's home (or be a `<dataDir>.backup-*`
  sibling), and the database and its side files, anything under `sslDir`, and
  live nginx configs are refused even when they are inside. A symlink is checked
  by its target and then unlinked, never followed. An id from a stale report or
  a hand-edited file can no longer become an arbitrary delete.
- **The daemon lock and the jobs marker are created exclusively.** Taking either
  one is a single `wx` open, so a check-then-write race cannot produce two
  winners; recovering a stale one is serialised behind its own guard and the
  file is only ever replaced by an atomic rename, never deleted and re-created.
  Six real processes racing for an empty lock, and for a stale one, now produce
  exactly one winner — the second case used to let one process delete another's
  brand-new lock. A half-written lock is recovered rather than blocking for ever.
- **`stopDashboard` verifies the pid before killing it.** A pid recorded in the
  settings table may have been reused by an unrelated process, so the recorded
  pid's command line must be exactly `node <dashboard entry script>` — parsed,
  not substring-matched — first. Anything unverifiable is not signalled, and the
  stale record is cleared with a reason.
- **The setup code is cleared when "no password" is chosen**, not only after a
  password is set. Setup is finished on that path too, and an outstanding
  credential nobody needs is one more thing that can be read.

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
refused outright, and the login page instead asks you to set one (the minimum
is 6 characters) before anything else works.

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

#### The session check in the frontend
The page returns to the login screen on any 401, with "Your session ended" —
rather than leaving a half-dead dashboard showing stale data — and the first
run shows a set-a-password form instead of the old "No password set? Leave
blank and press Sign In" hint.

#### The session check in the tests
New `e2e/dashboard-auth.test.mjs`: 87 checks over a dashboard on a random port
with a temporary data directory, asserting that **29 endpoints across all six
routers return 401 without a session**, that the same endpoints work with one,
that an anonymous Socket.io connection is refused and an authenticated one is
not, the first-run flow and its minimum length, rate limiting (including that a
correct password is still refused while limited), scrypt storage, plain-text
migration, and the upgrade-safe bind address.

### Documentation

#### The docs site covers steps, stages and pairing
The published documentation now has sections for deploy steps, runtimes and
presets (with the inherited-list behaviour), the SSL preflight and its nine live
stages, both Hub pairing methods including `ezz hub connect`, and the clean CLI
pages. `API-CONTRACT.md` is at 2.17.0 and describes the step precedence, the
per-check `preflight` array, the `not_issued`/`unreadable` split, `ssl:progress`,
`command:progress` with its optional `domain`, and the certificate state the Hub
shows on domain lists.

#### The contract moved to the repository root
- **The contract is `API-CONTRACT.md` at the repository root.** It used to be
  referenced as `docs/api-contract.md`; it now sits with the code it describes,
  and every reference in the source, the e2e runner, the UI and `CLAUDE.md`
  follows. It documents the outbound Hub agent events in their own subsection,
  the update endpoints' bodies and run record, and the React UI as the default.
  It is at 2.17.0 after this cycle.

#### The API contract and its enforcement
- **New `API-CONTRACT.md`** (contract v1.0.0), written from the current
  code: every dashboard REST endpoint with method, path, auth, request and
  response shapes and error codes; every Socket.io event in both directions with
  payload, emitter, and whether it belongs in the background daemon when that is
  split out; and the transport rules above.
- **The e2e runner now enforces it.** It reads the mount prefixes from
  `server.js` and the paths from each router's own Express stack — not a regex,
  which cannot see a route added through a helper or a nested router — and fails
  the run on any mismatch in either direction. Verified by adding an
  undocumented route and by removing a documented one.

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
