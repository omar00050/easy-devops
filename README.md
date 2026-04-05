<p align="center">
  <img src="src/dashboard/public/img/icon.png" alt="Easy DevOps" width="100" />
</p>

# Easy DevOps

[![npm version](https://badge.fury.io/js/easy-devops.svg)](https://badge.fury.io/js/easy-devops)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A unified DevOps management tool with interactive CLI and web dashboard for managing **Nginx**, **SSL certificates**, and **Node.js** on Linux and Windows servers.

No external ACME binaries required — SSL certificates are issued via [`acme-client`](https://www.npmjs.com/package/acme-client) (pure Node.js, Let's Encrypt).

## Features

- **🖥️ Interactive CLI** — Arrow-key menus with real-time status indicators
- **📊 Web Dashboard** — Modern Vue 3 interface with dark/light themes (`#161616` / `#d64a29` palette)
- **🌐 Nginx Management** — Start/stop/reload, config editor, error logs, install
- **🔒 SSL Certificate Management** — Let's Encrypt via `acme-client` (no certbot), HTTP-01 and DNS-01 challenges, wildcard certs, expiry tracking
- **🔗 Domain Management** — Reverse proxy configs with SSL, external URL backends, enable/disable, wildcard domains, WebSocket, gzip, rate limiting
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
easy-devops
```

### From Source

```bash
git clone https://github.com/omar00050/Easy-DevOps.git
cd Easy-DevOps
npm install
npm start
```

## Quick Start

```bash
# Start the interactive CLI
easy-devops

# Or run directly
npx easy-devops
```

## Usage

### CLI Overview

```
  ███████╗███████╗     Easy DevOps  v1.0.2
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
| **HTTP-01** | Easy DevOps stops nginx, binds port 80, serves the ACME token, then restarts nginx |
| **DNS-01** | You add a `_acme-challenge` TXT record to your DNS; Easy DevOps waits for confirmation |

> **Wildcard certificates** (`*.example.com`) require DNS-01 — HTTP-01 is automatically disabled for wildcard domains.

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

All configuration is stored in `data/easy-devops.sqlite`:

| Key | Contents |
|-----|----------|
| `config` | Dashboard port, password, `nginxDir`, `sslDir`, `acmeEmail` |
| `system-detection` | Cached system info (OS, Node, nginx) |
| `domains` | Array of domain configurations |

**Config fields:**

| Field | Default (Linux) | Default (Windows) | Description |
|-------|-----------------|-------------------|-------------|
| `dashboardPort` | `6443` | `6443` | Dashboard HTTP port |
| `dashboardPassword` | `admin` | `admin` | Dashboard login password |
| `nginxDir` | `/etc/nginx` | `C:\nginx` | Nginx installation directory |
| `sslDir` | `/etc/easy-devops/ssl` | `C:\easy-devops\ssl` | SSL certificate storage root |
| `acmeEmail` | _(empty)_ | _(empty)_ | Email for Let's Encrypt account (**required** for cert issuance) |

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
│   │   └── public/           # Static assets (Vue 3 app)
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
npm start

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
