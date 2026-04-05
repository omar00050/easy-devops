# Changelog

All notable changes to Easy DevOps are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
