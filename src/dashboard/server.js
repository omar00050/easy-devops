import { createServer } from 'http';
import { createRequire } from 'module';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import session from 'express-session';
import { Server as SocketIO } from 'socket.io';
import { loadConfig } from '../core/config.js';
import { dbGet, dbSet } from '../core/db.js';

const require = createRequire(import.meta.url);
const FileStore = require('session-file-store')(session);
import authRouter from './routes/auth.js';
import domainsRouter from './routes/domains.js';
import sslRouter from './routes/ssl.js';
import nginxRouter from './routes/nginx.js';
import settingsRouter from './routes/settings.js';
import { getStatus } from './lib/nginx-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// EJS view engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json({ limit: '1mb' }));

// ─── Session secret — generated once, persisted in SQLite ────────────────────
let sessionSecret = dbGet('session_secret');
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  dbSet('session_secret', sessionSecret);
}

// Sessions stored on disk so they survive restarts
const SESSION_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'easy-devops', 'sessions')
  : path.join(os.homedir(), '.config', 'easy-devops', 'sessions');

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: new FileStore({ path: SESSION_DIR, retries: 1, logFn() {} }),
  cookie: { httpOnly: true },
}));

// Static files - disable index serving so EJS handles root
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use('/api', authRouter);
app.use('/api/domains', domainsRouter);
app.use('/api/ssl', sslRouter);
app.use('/api/nginx', nginxRouter);
app.use('/api', settingsRouter);

// Render EJS template for all other routes
app.use((req, res) => res.render('index'));

// ─── HTTP server + Socket.io ──────────────────────────────────────────────────

const httpServer = createServer(app);
const io = new SocketIO(httpServer);

let connectedClients = 0;

async function emitNginxStatus(target) {
  try {
    const status = await getStatus();
    target.emit('nginx:status', status);
  } catch (err) {
    target.emit('nginx:status', { running: false, version: null, pid: null, error: err.message });
  }
}

io.on('connection', (socket) => {
  connectedClients++;
  emitNginxStatus(socket);
  socket.on('disconnect', () => { connectedClients--; });
});

// Broadcast nginx status to all clients every 5 seconds
setInterval(() => {
  if (connectedClients > 0) emitNginxStatus(io);
}, 5000);

// ─── Start ────────────────────────────────────────────────────────────────────

const { dashboardPort } = loadConfig();
const port = Number(process.env.DASHBOARD_PORT) || dashboardPort;
httpServer.listen(port, () => {
  process.stdout.write(`Dashboard running on port ${port}\n`);
});

export { app };
