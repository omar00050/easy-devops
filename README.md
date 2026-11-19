<p align="center">
  <img src="src/dashboard/public/img/icon_b.png" alt="Easy DevOps" width="100" />
</p>

# Easy DevOps

[![npm version](https://badge.fury.io/js/easy-devops.svg)](https://badge.fury.io/js/easy-devops)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A unified DevOps management tool with interactive CLI and web dashboard for managing **Nginx**, **SSL certificates**, and **Node.js** on Linux and Windows servers.

No external ACME binaries required — SSL certificates are issued via [`acme-client`](https://www.npmjs.com/package/acme-client) (pure Node.js, Let's Encrypt).

> **Tip:** Two CLI commands are available: **`easy-devops`** (full name) and **`ezz`** (short alias). Both are registered in the npm bin and do exactly the same thing.

## Features

- **🖥️ Interactive CLI** — Arrow-key menus with real-time status indicators
- **📊 Web Dashboard** — React interface with dark/light themes (`#161616` / `#d64a29` palette), shipped prebuilt — nothing is loaded from a CDN
- **🌐 Nginx Management** — Start/stop/reload, config editor, error logs, install
- **🔒 SSL Certificate Management** — Let's Encrypt via `acme-client` (no certbot), HTTP-01 and DNS-01 challenges, wildcard certs, expiry tracking, **automatic renewal** in the background
- **🔗 Domain Management** — Reverse proxy configs with SSL, external URL backends, enable/disable, wildcard domains, WebSocket, gzip, rate limiting
- **🚀 Deployments** — Put a project from a git repository on the server: built there, run under PM2, health-checked, rolled back automatically, with earlier releases kept. Trigger from the dashboard or from GitHub Actions; an optional `ez.json` keeps the commands with the code
- **📦 Node.js Manager** — Version switching via nvm / nvm-windows, global package management
- **🔄 Real-time Updates** — Socket.io powered status updates in dashboard
- **💿 SQLite Storage** — Persistent configuration via `good.db`

## Requirements

- **Node.js 18+** (with npm)
- **Linux** (Debian/Ubuntu/etc.) or **Windows**
- ⚠️ **Windows users: PowerShell must be run as Administrator** (required for managing services and SSL certificates)
- Optional: Nginx, nvm (installed separately or via the tool)

## Installation

### Quick Install (One-Line)

If you have **Node.js 18+** installed, run:

```bash
npm install -g easy-devops && easy-devops
# Short alias also available: ezz
```

If you **don't have Node.js** yet, use the bootstrap installer:

#### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/omar00050/Easy-DevOps/main/install.sh -o install.sh && bash install.sh
```

Or with wget:

```bash
wget -qO install.sh https://raw.githubusercontent.com/omar00050/Easy-DevOps/main/install.sh && bash install.sh
```

#### Windows (PowerShell)

> ⚠️ **Important:** Run PowerShell **as Administrator**. Right-click PowerShell → "Run as Administrator".

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/omar00050/Easy-DevOps/main/install.ps1" -OutFile "install.ps1"; ./install.ps1
```

Or from Command Prompt:

```cmd
powershell -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/omar00050/Easy-DevOps/main/install.ps1' -OutFile 'install.ps1'; ./install.ps1"
```

> **What the installer does:**
> 1. Checks for Node.js 18+ (installs via nvm if missing)
> 2. Installs Easy DevOps globally via npm
> 3. Launches the interactive CLI

### Via npm (Recommended)

```bash
npm install -g easy-devops
easy-devops   # or: ezz
```

### From Source

```bash
git clone https://github.com/omar00050/Easy-DevOps.git
cd Easy-DevOps
npm install
npm start          # or: easy-devops / ezz
```

## Quick Start

```bash
# Start the interactive CLI
easy-devops

# Short alias — same thing, faster to type
ezz

# Or run without installing
npx easy-devops
```

## Usage

### CLI Overview

```
  ███████╗███████╗     Easy DevOps  v2.0.0
  ██╔════╝╚════██╗     ─────────────────────
  █████╗      ██╔╝     CLI & Web Dashboard
  ██╔══╝     ██╔╝      Nginx · SSL · Domains · Node.js
  ███████╗ ██████╗
  ╚══════╝ ╚═════╝

  nginx: ✅ v1.26.2 | ACME: acme-client | node: v22.21.1

? Select an option:
  📦 Node.js Manager
  🌐 Nginx Manager
  🔒 SSL Manager
  🔗 Domain Manager
  🔌 Hub
  🎛️ Open Dashboard
  ⚙️ Settings
  🔄 Check for Updates
  ✖ Exit
```

Press **Ctrl+C** at any prompt to exit cleanly.

---

### Node.js Manager

Manage your Node.js runtime using `nvm` (Unix) or `nvm-windows` (Windows).

| Option | Description |
|--------|-------------|
| Switch Node version | Lists available LTS versions and switches to the selected one |
| Manage global packages | Install, uninstall, or list globally installed npm packages |
| Update npm | Updates npm to the latest version |

---

### Nginx Manager

Control the Nginx web server from the CLI.

| Option | Description |
|--------|-------------|
| Reload nginx | Tests the config then sends a graceful reload signal |
| Restart nginx | Tests the config then performs a full stop/start |
| Test config | Runs `nginx -t` and displays the result |
| View error log | Shows the last 50 lines of the Nginx error log |
| Install nginx | Installs Nginx via `apt-get` (Linux) or `winget` (Windows) |

---

### Domain Manager

Manage Nginx reverse proxy configurations from CLI or dashboard.

| Option | Description |
|--------|-------------|
| List Domains | Show all configured domains in a table (with status) |
| Add Domain | Interactive prompts for domain configuration |
| Edit Domain | Modify existing domain settings |
| Enable / Disable Domain | Toggle domain on/off without deleting config |
| Delete Domain | Remove domain (with option to also delete SSL files) |

**Domain Configuration Options:**
- Backend: local host:port (`127.0.0.1:3000`) or full external URL (`https://app.vercel.app`)
- Wildcard domain (`*.example.com`) — auto-enforces DNS-01 SSL validation
- SSL/HTTPS with certificate management
- WebSocket support (`ws` upstream type)
- Gzip compression
- Rate limiting (requests/second + burst)
- Security headers (X-Frame-Options, etc.)
- Custom timeout and body size limits
- Domain-specific access logs

---

### SSL Manager

Issue and renew Let's Encrypt SSL certificates via `acme-client` — no certbot or external binaries required.

| Status | Meaning |
|--------|---------|
| ✅ green | Valid, expires in > 30 days |
| ⚠️ yellow | Expiring soon (10–30 days) |
| ❌ red | Critical (< 10 days) |

#### Challenge Methods

| Method | How it works |
|--------|-------------|
| **HTTP-01** | nginx keeps running and proxies the ACME challenge to Easy DevOps (proxy mode). Only when nginx is not running, or not serving port 80, does it fall back to binding port 80 itself (standalone mode) |
| **DNS-01** | You add a `_acme-challenge` TXT record to your DNS; Easy DevOps waits for confirmation |

> **Wildcard certificates** (`*.example.com`) require DNS-01 — HTTP-01 is automatically disabled for wildcard domains.

#### Automatic renewal

The background service (`ezz service install`) renews certificates on its own, so nothing has to be open:

- **HTTP-01 certificates are renewed 7 days before they expire.** Change the window, or switch it off, in **Settings** (dashboard or CLI): `sslAutoRenew`, `sslAutoRenewDays` (1–30).
- **nginx is never stopped by an unattended renewal.** With the default challenge mode it uses proxy mode only, then reloads nginx so the new certificate is the one being served.
- **A renewal keeps the certificate's names** — one issued with `www` is renewed with `www`.
- **DNS-01 certificates (every wildcard) are not renewed automatically**: they need a TXT record you add at your DNS provider. They keep getting the expiry warning, which says a manual renewal is needed.
- **Certificates no enabled domain uses are left alone**, so a leftover cannot spend Let's Encrypt's failure budget.
- **You are notified either way** — "renewed" or "renewal failed, and why" — on the channels configured for that domain's certificate-expiry event. A failed attempt is retried on the next check (every 12 hours).

Without the background service the same job runs while the dashboard is open.

#### Certificate Storage

Certificates are stored under `sslDir` (configured in Settings):

```
{sslDir}/{domain}/fullchain.pem
{sslDir}/{domain}/privkey.pem
{sslDir}/.account/account.key     ← ACME account key, reused across all issuances
```

Default paths:
- Linux: `/etc/easy-devops/ssl/`
- Windows: `C:\easy-devops\ssl\`

---

### Deployments

Put a project from a git repository on the server and keep it deployed. From the dashboard: **Deployments → New app**, give it a repository, press **Deploy**.

One deployment: fetch into a new release folder → read settings → `pre` hook → install → build → stop the old process and start the new one under PM2 (`ez-<name>`) → health check → `post` hook. Nothing before the switch touches what is running, so a broken build costs nothing; if the new release starts but is not healthy, **the previous release is started again automatically**.

> The switch is a restart, not a zero-downtime handover: the app is down for as long as it takes to start.

**Requirements:** `git` and PM2 (`npm install -g pm2`) on the server.

#### ez.json (optional)

Keeps the commands with the code. Looked for at `ez.json`, `deploy/ez.json`, then `.deploy/ez.json`.

```json
{
  "install": "npm ci",
  "build": "npm run build",
  "start": "node dist/server.js",
  "port": 3000,
  "health": "/healthz",
  "hooks": { "pre": "node scripts/check-env.js", "post": "node scripts/warm-cache.js" }
}
```

- Without it, a Node project is deployed from `package.json`: `npm ci` (yarn and pnpm are detected from the lockfile), the `build` script if there is one, and the `start` script.
- With it, the commands run **exactly as written, whatever the language** — `"start": "python app.py"` works.
- `install` / `build` take a command, a list, or `false` to skip. `port` is passed to the app as `PORT` and used for the health check.
- Anything set on the app in the dashboard overrides `ez.json`.

#### A domain for the app

In the app's **Domain & folder** tab, type a domain name. A new name is created; an existing domain is re-pointed at the app. nginx proxies it to the app's port, and a deployment that changes the port takes the domain with it. Tick *Request an SSL certificate* to issue one over HTTP-01 at the same time — if it cannot be issued (the DNS does not point here yet) the domain still works over HTTP.

Deleting an app asks what to do with its domain; the default is to keep it.

#### Where apps live

New apps are created in the **deployments folder** — `ez_deploys` inside the Easy DevOps data directory by default, changeable in Settings (dashboard or CLI). **Changing the setting never moves an existing app**: each app records the folder it was created in and keeps using it.

To move one, use **Move app** in its Domain & folder tab and give a folder: the app is stopped in PM2, its folder is moved to `<folder>/<app name>`, and it is started again from there.

#### Repository access

| | URL | |
|---|---|---|
| Public | `https://…` | No credentials |
| Deploy key | `git@github.com:owner/repo.git` | An SSH key generated per app; add its public half to the repository, read-only |
| Access token | `https://…` | A personal access token stored on the server |

#### Deploying from GitHub Actions

Switch on the **deploy hook** (off by default), create the app's deploy token, add the two repository secrets the dashboard lists (`EZ_DEPLOY_URL`, `EZ_DEPLOY_TOKEN`) and commit the workflow file it generates. Every push then deploys that commit, and the check on GitHub is red if the deployment fails.

- **Through one of your domains (recommended):** one path, `/.ez-deploy/`, is added to that domain's nginx config, so the token travels over the domain's HTTPS. Nothing of the dashboard becomes reachable.
- **Directly, on its own port (6445):** plain HTTP — the token is sent unencrypted. For private networks.

- **Through the Hub (paired servers):** the Action calls the Hub, which forwards the request down the connection the server already holds open — no inbound port, no public domain. The server still verifies the token itself; the Hub stores nothing. Enable “Deploy from CI through the Hub” in Settings → Hub.

The workflow file is the same whichever way you choose; only the value of `EZ_DEPLOY_URL` differs.

**Do it for me:** on a github.com repository the dashboard can store both secrets, commit the workflow file and add the deploy key itself, given a GitHub token that may write the repository's secrets, contents and workflows. A token typed for this is used once and not stored.

A deploy token can start a deployment of its own app from that app's configured repository, and nothing else. Only its hash is stored.

#### Deploying from the Hub

A paired server's apps appear on its Hub page. What the Hub may do is decided on the server (Settings → Hub), one switch per action: deploy, roll back, read deployment logs, create/edit/delete apps, read and edit environment variables, and deploy from CI. All are off until you turn them on. The Hub is never sent environment values except while someone with that permission is editing them.

---

### Web Dashboard

Start the web dashboard:

```bash
# From CLI menu: Select "🎛️ Open Dashboard" → "Start dashboard"
# Or directly:
npm run dashboard
```

Access at `http://localhost:6443` (or configured port).

#### First-Time Login

Default credentials:
- **Username:** `admin`
- **Password:** Set in Settings menu or check your configuration

> **Tip:** From the Dashboard menu, select "How to use" for a quick guide on getting started.

#### Dashboard Pages

| Page | Features |
|------|----------|
| **Overview** | System status cards for Nginx, SSL, Domains |
| **Nginx** | Start/stop controls, config editor, error logs |
| **SSL** | Certificate list, renewal actions, expiry badges |
| **Domains** | Add/edit form with collapsible sections, table view |
| **Settings** | Port, password, directory configuration, Linux permissions setup |

> **Linux users:** After launching the dashboard for the first time, open **Settings → Linux Permissions** and click **Setup Permissions**. This writes `/etc/sudoers.d/easy-devops` with NOPASSWD rules for `systemctl` so nginx start/stop/reload/restart work from the dashboard without a terminal. Without this step, nginx service control will return "Linux permissions not configured" errors.

---

## API Endpoints

The dashboard exposes RESTful API endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/nginx/status` | GET | Get nginx running status |
| `/api/nginx/start` | POST | Start nginx |
| `/api/nginx/stop` | POST | Stop nginx |
| `/api/nginx/reload` | POST | Graceful reload |
| `/api/nginx/configs` | GET | List config files |
| `/api/nginx/config/:file` | GET/POST | Read/write config file |
| `/api/domains` | GET/POST | List/create domains |
| `/api/domains/:name` | PUT/DELETE | Update/delete domain |
| `/api/domains/:name/toggle` | PUT | Enable or disable domain |
| `/api/domains/:name/reload` | POST | Reload nginx for domain |
| `/api/ssl` | GET | List certificates |
| `/api/ssl/create` | POST | Issue new certificate |
| `/api/ssl/create-confirm` | POST | Confirm DNS challenge |
| `/api/ssl/renew/:domain` | POST | Renew certificate |
| `/api/settings` | GET/POST | Dashboard settings |
| `/api/settings/permissions` | GET | Linux sudo permissions status |
| `/api/settings/permissions/setup` | POST | Configure NOPASSWD sudoers (Linux) |

---

## Configuration

All configuration is stored in a persistent user directory (never inside the npm package, so it survives updates):

**Database location:**
- Linux/macOS: `~/.config/easy-devops/easy-devops.sqlite`
- Windows: `%APPDATA%\easy-devops\easy-devops.sqlite`

| Key | Contents |
|-----|----------|
| `config` | Dashboard port, password, `nginxDir`, `sslDir`, `acmeEmail` |
| `system-detection` | Cached system info (OS, Node, nginx) |
| `domains` | Array of domain configurations |

**Config fields:**

| Field | Default (Linux) | Default (Windows) | Description |
|-------|-----------------|-------------------|-------------|
| `dashboardPort` | `6443` | `6443` | Dashboard HTTP port |
| `dashboardPasswordHash` | _(none)_ | _(none)_ | Set on first run with a one-time setup code; stored scrypt-hashed, never in plain text |
| `nginxDir` | `/etc/nginx` | `C:\nginx` | Nginx installation directory |
| `sslDir` | `/etc/easy-devops/ssl` | `C:\easy-devops\ssl` | SSL certificate storage root |
| `acmeEmail` | _(empty)_ | _(empty)_ | Email for Let's Encrypt account (**required** for cert issuance) |
| `sslAutoRenew` | `true` | `true` | Renew HTTP-01 certificates in the background |
| `sslAutoRenewDays` | `7` | `7` | How many days before expiry to renew (1–30) |
| `deployDir` | `<data dir>/ez_deploys` | `<data dir>\ez_deploys` | Folder new deployed apps are created in |

---

## Project Structure

```
easy-devops/
├── src/
│   ├── cli/
│   │   ├── index.js          # CLI entry point
│   │   ├── managers/         # Domain, Nginx, SSL, Node.js logic
│   │   └── menus/            # Thin menu dispatcher wrappers
│   ├── core/
│   │   ├── config.js         # Configuration load/save
│   │   ├── cert-renewal.js   # Certificate renewal: manual and automatic
│   │   ├── deploy/           # Deployments: ez.json, app registry, engine, deploy hook
│   │   ├── db.js             # SQLite helpers (good.db)
│   │   ├── detector.js       # System environment detection
│   │   ├── nginx-conf-generator.js  # Nginx conf builder (shared)
│   │   ├── platform.js       # isWindows, nginx cmd helpers, combineOutput
│   │   ├── shell.js          # Cross-platform shell executor
│   │   └── validators.js     # Shared input validation helpers
│   ├── dashboard/
│   │   ├── server.js         # Express + Socket.io server
│   │   ├── routes/           # auth, domains, nginx, settings, ssl
│   │   ├── lib/              # cert-reader, domains-db, nginx-service
│   │   ├── views/            # EJS templates + partials
│   │   ├── ui/               # React dashboard sources (Vite) → built into dist/ui
│   │   └── public/           # Static assets for the classic EJS fallback
│   └── lib/
│       └── installer/        # Bash helper modules for install.sh
├── data/
│   └── easy-devops.sqlite
├── install.sh            # Linux/macOS bootstrap installer
└── install.ps1           # Windows PowerShell installer
```

---

## Platform Support

| Feature | Linux | Windows |
|---------|-------|---------|
| CLI Interface | ✅ | ✅ |
| Web Dashboard | ✅ | ✅ |
| Nginx Management | ✅ | ✅ |
| SSL — HTTP-01 (acme-client) | ✅ | ✅ |
| SSL — DNS-01 (acme-client) | ✅ | ✅ |
| Wildcard Certificates | ✅ | ✅ |
| Node.js (nvm) | ✅ | ✅ (nvm-windows) |
| Nginx service control | systemctl | nginx.exe direct |

---

## Development

```bash
# Clone and install
git clone https://github.com/omar00050/Easy-DevOps.git
cd Easy-DevOps
npm install

# Run CLI
npm start          # or: easy-devops / ezz

# Run dashboard
npm run dashboard

# System info only
npm run system-info
```

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for a full history of changes.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## Author

**Omar Farghaly**

- GitHub: [@omar00050](https://github.com/omar00050)
- npm: [abo_farghaly](https://www.npmjs.com/~abo_farghaly)

---

## Support

If you encounter any issues or have questions, please [open an issue](https://github.com/omar00050/Easy-DevOps/issues) on GitHub.
