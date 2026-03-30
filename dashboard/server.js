import { createServer } from 'http';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import session from 'express-session';
import { Server as SocketIO } from 'socket.io';
import { loadConfig } from '../core/config.js';
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

app.use(express.json());

app.use(session({
  secret: 'easy-devops-secret',
  resave: false,
  saveUninitialized: false,
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
