# Easy DevOps

[![npm version](https://badge.fury.io/js/easy-devops.svg)](https://badge.fury.io/js/easy-devops)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A unified DevOps management tool with interactive CLI and web dashboard for managing **Nginx**, **SSL certificates**, and **Node.js** on Linux and Windows servers.

## Features

- **🖥️ Interactive CLI** — Arrow-key menus with real-time status indicators
- **📊 Web Dashboard** — Modern Vue 3 interface with dark/light themes
- **🌐 Nginx Management** — Start/stop/reload, config editor, error logs
- **🔒 SSL Certificate Management** — Let's Encrypt via Certbot, expiry tracking
- **🔗 Domain Management** — Reverse proxy configurations with SSL, WebSocket, gzip, rate limiting
- **📦 Node.js Manager** — Version switching via nvm, global package management
- **🔄 Real-time Updates** — Socket.io powered status updates in dashboard
- **💿 SQLite Storage** — Persistent configuration via `good.db`

## Requirements

- **Node.js 18+** (with npm)
- **Linux** (Debian/Ubuntu) or **Windows**
- Optional: Nginx, Certbot, nvm (installed separately or via the tool)

## Installation

### Quick Install (One-Line)

If you have **Node.js 18+** installed, run:

```bash
npm install -g easy-devops && easy-devops
```

If you **don't have Node.js** yet, use the bootstrap installer:

#### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/omar00050/Easy-DevOps/main/install.sh | bash
```

Or with wget:

```bash
wget -qO- https://raw.githubusercontent.com/omar00050/Easy-DevOps/main/install.sh | bash
```

#### Windows (PowerShell)

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
╔══════════════════════════════╗
║      Easy DevOps v0.1.0     ║
╚══════════════════════════════╝

nginx: ✅ v1.26.2 | certbot: ✅ v2.9.0 | node: v22.21.1

? Select an option:
  📦 Node.js Manager
  🌐 Nginx Manager
  🔒 SSL Manager
  🔗 Domain Manager
  🎛️ Open Dashboard
  ⚙️ Settings
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
| List Domains | Show all configured domains in a table |
| Add Domain | Interactive prompts for domain configuration |
| Edit Domain | Modify existing domain settings |
| Delete Domain | Remove domain with confirmation |

**Domain Configuration Options:**
- SSL/HTTPS with auto-renewal tracking
- WebSocket support (`ws` upstream type)
- Gzip compression
- Rate limiting (requests/second + burst)
- Security headers (X-Frame-Options, etc.)
- Custom timeout and body size limits
- Domain-specific access logs

---

### SSL Manager

Manage Let's Encrypt SSL certificates using Certbot.

| Status | Meaning |
|--------|---------|
| ✅ green | Valid, expires in > 30 days |
| ⚠️ yellow | Expiring soon (10–30 days) |
| ❌ red | Critical (< 10 days) |

> **Note:** Renewing a certificate temporarily stops Nginx to free port 80, then restarts it automatically.

---

### Web Dashboard

Start the web dashboard:

```bash
# From CLI menu: Select "🎛️ Open Dashboard" → "Start dashboard"
# Or directly:
npm run dashboard
```

Access at `http://localhost:3000` (or configured port).

#### Dashboard Pages

| Page | Features |
|------|----------|
| **Overview** | System status cards for Nginx, SSL, Domains |
| **Nginx** | Start/stop controls, config editor, error logs |
| **SSL** | Certificate list, renewal actions, expiry badges |
| **Domains** | Add/edit form with collapsible sections, table view |
| **Settings** | Port, password, directory configuration |

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
| `/api/domains/:name` | GET/PUT/DELETE | Domain CRUD |
| `/api/ssl` | GET | List certificates |
| `/api/ssl/renew/:domain` | POST | Renew certificate |
| `/api/settings` | GET/POST | Dashboard settings |

---

## Configuration

All configuration is stored in `data/easy-devops.sqlite`:

| Key | Contents |
|-----|----------|
| `config` | Dashboard port, password, Nginx/Certbot directories |
| `system-detection` | Cached system info (OS, Node, nginx, certbot) |
| `domains` | Array of domain configurations |

---

## Project Structure

```
easy-devops/
├── cli/
│   ├── index.js          # CLI entry point
│   ├── managers/         # Business logic modules
│   └── menus/            # Menu dispatcher stubs
├── core/
│   ├── config.js         # Configuration loader
│   ├── db.js             # SQLite database (good.db)
│   ├── detector.js       # System environment detection
│   └── shell.js          # Cross-platform shell executor
├── dashboard/
│   ├── server.js         # Express + Socket.io server
│   ├── routes/           # API endpoints
│   ├── lib/              # Service helpers
│   ├── views/            # EJS templates
│   └── public/           # Static assets (Vue app)
├── data/
│   └── easy-devops.sqlite
└── lib/
    └── installer/        # Bootstrap scripts
```

---

## Platform Support

| Feature | Linux | Windows |
|---------|-------|---------|
| CLI Interface | ✅ | ✅ |
| Web Dashboard | ✅ | ✅ |
| Nginx Management | ✅ | ✅ |
| SSL (Certbot) | ✅ | ✅ |
| Node.js (nvm) | ✅ | ✅ (nvm-windows) |
| System Service | systemd | Task Scheduler |

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
