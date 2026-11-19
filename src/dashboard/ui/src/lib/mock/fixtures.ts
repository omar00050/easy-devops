/**
 * lib/mock/fixtures.ts — data shaped from API-CONTRACT.md.
 *
 * Every page is built against these first, so each fixture carries the awkward
 * cases as well as the happy ones: a certificate expiring in days, an expired
 * one, an unreadable one, a disabled domain, an unmanaged PM2 app, a stopped
 * backend.
 */

import type {
  Certificate,
  Domain,
  DomainNotifications,
  HubStatus,
  NginxStatus,
  NotificationChannel,
  PermissionGroup,
  ProcessApp,
  ProcessesResponse,
  ServiceStatus,
  Settings,
} from '../types';

export const isoDaysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString();

export const defaultNotifications = (): DomainNotifications => ({
  nginx_down: { enabled: true, channelIds: [] },
  cert_expiry: { enabled: true, channelIds: [] },
  domain_health: { enabled: true, channelIds: [] },
});

function domain(overrides: Partial<Domain> & Pick<Domain, 'name' | 'port'>): Domain {
  const now = isoDaysFromNow(-40);
  return {
    backendHost: '127.0.0.1',
    upstreamType: 'http',
    www: false,
    wildcard: false,
    enabled: true,
    configFile: `/etc/nginx/conf.d/${overrides.name}.conf`,
    createdAt: now,
    updatedAt: now,
    ssl: {
      enabled: false,
      certPath: '',
      keyPath: '',
      redirect: true,
      hsts: false,
      hstsMaxAge: 31_536_000,
    },
    performance: {
      maxBodySize: '10m',
      readTimeout: 60,
      connectTimeout: 10,
      proxyBuffers: false,
      gzip: true,
      gzipTypes:
        'text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript',
    },
    security: {
      rateLimit: false,
      rateLimitRate: 10,
      rateLimitBurst: 20,
      securityHeaders: false,
      custom404: false,
      custom50x: false,
    },
    advanced: { accessLog: true, customLocations: '' },
    certExpiry: null,
    daysLeft: null,
    notifications: defaultNotifications(),
    ...overrides,
  };
}

const sslPaths = (name: string) => ({
  certPath: `/etc/easy-devops/ssl/${name}/fullchain.pem`,
  keyPath: `/etc/easy-devops/ssl/${name}/privkey.pem`,
});

export function seedDomains(): Domain[] {
  return [
    domain({
      name: 'app.example.com',
      port: 3000,
      www: true,
      ssl: {
        enabled: true,
        ...sslPaths('app.example.com'),
        redirect: true,
        hsts: true,
        hstsMaxAge: 31_536_000,
      },
      certExpiry: isoDaysFromNow(95),
      daysLeft: 95,
      security: {
        rateLimit: true,
        rateLimitRate: 10,
        rateLimitBurst: 20,
        securityHeaders: true,
        custom404: false,
        custom50x: false,
      },
      notifications: {
        nginx_down: { enabled: true, channelIds: ['ch-discord-ops'] },
        cert_expiry: {
          enabled: true,
          channelIds: ['ch-discord-ops', 'ch-telegram-oncall'],
        },
        domain_health: { enabled: false, channelIds: [] },
      },
    }),
    domain({
      name: 'api.example.com',
      port: 8080,
      upstreamType: 'https',
      ssl: {
        enabled: true,
        ...sslPaths('api.example.com'),
        redirect: false,
        hsts: false,
        hstsMaxAge: 31_536_000,
      },
      certExpiry: isoDaysFromNow(12),
      daysLeft: 12,
      notifications: {
        nginx_down: { enabled: false, channelIds: [] },
        cert_expiry: { enabled: true, channelIds: ['ch-telegram-oncall'] },
        domain_health: { enabled: true, channelIds: ['ch-telegram-oncall'] },
      },
    }),
    domain({
      name: 'blog.example.com',
      port: 4000,
      backendHost: '10.0.0.12',
      security: {
        rateLimit: false,
        rateLimitRate: 10,
        rateLimitBurst: 20,
        securityHeaders: false,
        custom404: true,
        custom50x: false,
      },
      notifications: {
        nginx_down: { enabled: false, channelIds: [] },
        cert_expiry: { enabled: false, channelIds: [] },
        domain_health: { enabled: true, channelIds: ['ch-discord-ops'] },
      },
    }),
    domain({
      name: 'staging.example.com',
      port: 5000,
      enabled: false,
      configFile: '/etc/nginx/conf.d/staging.example.com.conf.disabled',
    }),
  ];
}

export function seedCertificates(): Certificate[] {
  return [
    { domain: 'app.example.com', expiry: isoDaysFromNow(95), daysLeft: 95, status: 'valid', autoRenew: 'auto', autoRenewDays: 7 },
    { domain: 'api.example.com', expiry: isoDaysFromNow(12), daysLeft: 12, status: 'expiring', autoRenew: 'manual', autoRenewDays: 7 },
    { domain: 'legacy.example.com', expiry: isoDaysFromNow(-3), daysLeft: -3, status: 'expired' },
    { domain: 'broken.example.com', expiry: null, daysLeft: null, status: 'error' },
    // Exists but no domain serves it yet — the "offer these paths" case for
    // blog.example.com, which was added without SSL.
    { domain: 'blog.example.com', expiry: isoDaysFromNow(64), daysLeft: 64, status: 'valid', autoRenew: 'unused', autoRenewDays: 7 },
  ];
}

export function seedChannels(): NotificationChannel[] {
  return [
    {
      id: 'ch-discord-ops',
      name: 'Ops Discord',
      type: 'discord',
      webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/example-token',
      message: 'Easy DevOps alert',
    },
    {
      id: 'ch-telegram-oncall',
      name: 'On-call Telegram',
      type: 'telegram',
      botToken: '7123456789:AAExampleTokenForMockOnly',
      chatId: '-1001234567890',
    },
  ];
}

export function seedNginxStatus(): NginxStatus {
  return { running: true, version: '1.24.0', pid: 1421 };
}

export function seedNginxConfigs(): Record<string, string> {
  return {
    'app.example.com.conf': `# Generated by Easy DevOps — manual edits are preserved on save only.
server {
    listen 80;
    server_name app.example.com www.app.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/easy-devops;
    }

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name app.example.com www.app.example.com;

    ssl_certificate     /etc/easy-devops/ssl/app.example.com/fullchain.pem;
    ssl_certificate_key /etc/easy-devops/ssl/app.example.com/privkey.pem;

    client_max_body_size 10m;
    gzip on;

    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`,
    'api.example.com.conf': `server {
    listen 80;
    server_name api.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/easy-devops;
    }

    location / {
        proxy_pass https://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`,
    'blog.example.com.conf': `server {
    listen 80;
    server_name blog.example.com;

    location / {
        proxy_pass http://10.0.0.12:4000;
        proxy_set_header Host $host;
    }
}
`,
    'default.conf': `server {
    listen 80 default_server;
    server_name _;

    location / {
        return 404;
    }
}
`,
  };
}

export function seedErrorLog(): string[] {
  const now = Date.now();
  const stamp = (offsetMs: number) => new Date(now - offsetMs).toISOString().replace('T', ' ').slice(0, 19);
  return [
    `2026/11/13 09:12:02 [notice] 1#1: using the "epoll" event method`,
    `2026/11/13 09:12:02 [notice] 1#1: nginx/1.24.0`,
    `2026/11/13 09:12:02 [notice] 1#1: OS: Linux 6.8.0-45-generic`,
    `${stamp(3_600_000)} [warn] 1421#1421: *241 an upstream response is buffered to a temporary file`,
    `${stamp(900_000)} [error] 1421#1421: *318 connect() failed (111: Connection refused) while connecting to upstream, client: 10.0.0.5, server: blog.example.com, request: "GET / HTTP/1.1", upstream: "http://10.0.0.12:4000/", host: "blog.example.com"`,
    `${stamp(240_000)} [warn] 1421#1421: *322 conflicting server name "staging.example.com" on 0.0.0.0:80, ignored`,
    `${stamp(30_000)} [error] 1421#1421: *330 open() "/var/www/easy-devops/.well-known/acme-challenge/test" failed (2: No such file or directory)`,
  ];
}

export function seedAccessLog(): string[] {
  const now = Date.now();
  const stamp = (offsetMs: number) =>
    new Date(now - offsetMs)
      .toISOString()
      .replace('T', ' ')
      .replace('Z', '');
  return [
    `10.0.0.5 - - [${stamp(120_000)}] "GET / HTTP/1.1" 200 4321 "-" "Mozilla/5.0"`,
    `10.0.0.8 - - [${stamp(90_000)}] "GET /api/health HTTP/1.1" 200 32 "-" "curl/8.5.0"`,
    `10.0.0.5 - - [${stamp(45_000)}] "POST /api/orders HTTP/1.1" 201 512 "-" "Mozilla/5.0"`,
    `10.0.0.9 - - [${stamp(20_000)}] "GET /assets/app.js HTTP/1.1" 200 18234 "https://app.example.com/" "Mozilla/5.0"`,
  ];
}

export function seedApps(): ProcessApp[] {
  return [
    {
      // A leftover from the PM2-based service. It must not appear in the PM2
      // list: that list is for the user's own apps only.
      name: 'ez-dashboard',
      pmId: 0,
      pid: 2190,
      status: 'online',
      cpu: 1.2,
      memoryBytes: 96_468_992,
      startedAt: Date.now() - 2 * 86_400_000,
      uptimeMs: 2 * 86_400_000,
      restarts: 0,
      unstableRestarts: 0,
      execPath: '/opt/easy-devops/src/cli/index.js',
      cwd: '/opt/easy-devops',
      user: 'deploy',
      managed: true,
      dataDir: '/var/lib/easy-devops',
    },
    {
      name: 'api-worker',
      pmId: 1,
      pid: 2401,
      status: 'online',
      cpu: 2.4,
      memoryBytes: 134_217_728,
      startedAt: Date.now() - 6 * 3_600_000,
      uptimeMs: 6 * 3_600_000,
      restarts: 2,
      unstableRestarts: 0,
      execPath: '/srv/api/worker.js',
      cwd: '/srv/api',
      user: 'deploy',
      managed: false,
      dataDir: null,
    },
    {
      name: 'legacy-app',
      pmId: 2,
      pid: null,
      status: 'stopped',
      cpu: null,
      memoryBytes: null,
      startedAt: null,
      uptimeMs: null,
      restarts: 14,
      unstableRestarts: 1,
      execPath: '/srv/legacy/server.js',
      cwd: '/srv/legacy',
      user: 'deploy',
      managed: false,
      dataDir: null,
    },
    {
      // A PM2 module, not one of the user's apps. It lives under PM2_HOME and
      // has no usage numbers, the way PM2 reports modules on Windows.
      name: 'pm2-logrotate',
      pmId: 3,
      pid: 2502,
      status: 'online',
      cpu: 0,
      memoryBytes: 0,
      startedAt: Date.now() - 12 * 3_600_000,
      uptimeMs: 12 * 3_600_000,
      restarts: 1,
      unstableRestarts: 0,
      execPath: '/home/deploy/.pm2/modules/pm2-logrotate/pm2-logrotate.js',
      cwd: '/home/deploy/.pm2/modules/pm2-logrotate',
      user: 'deploy',
      managed: false,
      dataDir: null,
    },
  ];
}

export function seedProcesses(): ProcessesResponse {
  return {
    pm2: { installed: true, version: '5.4.2', path: '/usr/local/bin/pm2' },
    apps: seedApps(),
    currentUser: 'deploy',
    pm2Home: '/home/deploy/.pm2',
  };
}

/** Mirrors API-CONTRACT.md 2.0.0 `GET /api/service`. */
export function seedService(): ServiceStatus {
  return {
    pm2: { installed: true, version: '6.0.14', path: '/usr/local/bin/pm2' },
    dev: false,
    dataDir: '/var/lib/easy-devops',
    backgroundService: {
      running: true,
      connected: true,
      pid: 2190,
      version: '1.2.1',
      startedAt: Date.now() - 2 * 86_400_000,
      heartbeatAgeMs: 4_000,
      jobsRunningHere: false,
      jobsOwnerPid: 2190,
      jobsOwnerRole: 'daemon',
      mechanism: 'systemd',
      mode: null,
      installed: true,
      startsAt: 'boot',
      stoppedByUser: false,
      stoppedAt: null,
      dataDir: '/var/lib/easy-devops',
      serverMode: false,
      detail: null,
      state: 'active',
      enabledOnBoot: true,
      restarts: 0,
      crashLooping: false,
      warnings: [],
      runtime: {
        systemNode: { path: '/usr/bin/node', version: 'v22.11.0', abi: '127' },
        pinned: {
          kind: 'symlink',
          path: '/var/lib/easy-devops/runtime/node',
          target: '/usr/bin/node',
          version: 'v22.11.0',
          exists: true,
          broken: false,
          differsFromSystem: false,
        },
        manager: { managed: false, manager: null },
        mixed: { mixed: false, msiPath: null, managed: null },
        warnings: [],
      },
    },
    install: { command: 'ezz service install', needsElevation: false, shell: null },
    probes: { ageMs: 800, fresh: true, pending: false, refreshing: false },
  };
}

export function seedSettings(): Settings {
  return {
    dashboardPort: 6443,
    nginxDir: '/etc/nginx',
    sslDir: '/etc/easy-devops/ssl',
    acmeEmail: 'ops@example.com',
    sslAutoRenew: true,
    sslAutoRenewDays: 7,
    sslAutoRenewDaysMin: 1,
    sslAutoRenewDaysMax: 30,
    deployDir: '/home/ops/.config/easy-devops/ez_deploys',
    deployDirDefault: '/home/ops/.config/easy-devops/ez_deploys',
    deployDirIsDefault: true,
    dashboardBindAddress: '127.0.0.1',
    bindsToLoopbackOnly: true,
    dashboardAuth: 'password',
    dashboardUi: 'new',
    canUseNoPassword: true,
    hasPassword: true,
    platform: 'linux',
  };
}

/** Mirrors src/core/hubPermissions.js exactly. */
export const PERMISSION_TREE: PermissionGroup[] = [
  {
    id: 'nginx',
    label: 'Nginx',
    description: 'Control the nginx service and its configuration files.',
    children: [
      { id: 'nginx.start', label: 'Start', description: 'Start nginx when it is stopped.' },
      { id: 'nginx.stop', label: 'Stop', description: 'Stop nginx. Your sites go offline until it is started again.' },
      { id: 'nginx.restart', label: 'Restart', description: 'Full restart. Briefly drops connections.' },
      { id: 'nginx.reload', label: 'Reload', description: 'Graceful reload. Picks up config changes without dropping connections.' },
      { id: 'nginx.test', label: 'Test config', description: 'Run nginx -t. Read-only, changes nothing.' },
      { id: 'nginx.config.view', label: 'View configs', description: 'Read the generated nginx config files.' },
      { id: 'nginx.config.edit', label: 'Edit configs', description: 'Edit a config file. Always tested before it is kept, and rolled back if nginx rejects it.' },
      { id: 'nginx.logs.view', label: 'View logs', description: 'Read recent nginx access and error log lines.' },
    ],
  },
  {
    id: 'domains',
    label: 'Domains',
    description: 'Manage reverse proxy domains and their nginx configs.',
    children: [
      { id: 'domains.create', label: 'Create', description: 'Add a new domain and generate its nginx config.' },
      { id: 'domains.edit', label: 'Edit', description: 'Change an existing domain and regenerate its config.' },
      { id: 'domains.toggle', label: 'Enable / disable', description: 'Take a domain in or out of service without deleting it.' },
      { id: 'domains.delete', label: 'Delete', description: 'Remove a domain and its nginx config.' },
    ],
  },
  {
    id: 'ssl',
    label: 'SSL certificates',
    description: 'Issue, renew and remove Let’s Encrypt certificates.',
    children: [
      { id: 'ssl.renew', label: 'Renew one', description: 'Renew a single certificate. nginx keeps running.' },
      { id: 'ssl.renewAll', label: 'Renew all expiring', description: 'Renew every certificate expiring within 30 days.' },
      { id: 'ssl.issue', label: 'Issue new', description: 'Request a new certificate over HTTP-01. nginx keeps running.' },
      { id: 'ssl.delete', label: 'Delete', description: 'Delete certificate files. Refused while an enabled domain still uses them.' },
      {
        id: 'ssl.issueDns',
        label: 'Issue wildcard (DNS-01)',
        description:
          'Wildcard certificates need a DNS TXT record you add by hand, so they cannot be driven from the Hub yet.',
        comingSoon: true,
      },
    ],
  },
  {
    id: 'deploy',
    label: 'Deployments',
    description:
      'Deploy the apps on this server from the Hub. Fetching code and running its commands happens here, with this server’s own settings.',
    children: [
      { id: 'deploy.run', label: 'Deploy', description: 'Start a deployment of an existing app from its configured repository.' },
      { id: 'deploy.rollback', label: 'Roll back', description: 'Switch an app back to an earlier release that is still on this server.' },
      { id: 'deploy.logs', label: 'View deployment logs', description: 'Read the output of a deployment. Build output can contain whatever the build prints.' },
      { id: 'deploy.manage', label: 'Create, edit and delete apps', description: 'Add an app from a repository, change its settings, issue its deploy token, or remove it. This decides which code runs here.' },
      { id: 'deploy.env', label: 'Read and edit environment variables', description: 'See and change an app’s environment values. They pass through the Hub while being edited and are not stored there.' },
      { id: 'deploy.ci', label: 'Deploy from CI through the Hub', description: 'Let a GitHub Action trigger a deployment by calling the Hub with the app’s own deploy token, so this server needs no inbound port.' },
    ],
  },
  {
    id: 'process',
    label: 'Processes',
    description:
      'Control the PM2 processes on this server. Easy DevOps itself runs as a background service, not a PM2 app, so it cannot be controlled from here.',
    children: [
      { id: 'process.start', label: 'Start', description: 'Start a stopped PM2 process from the Hub.' },
      { id: 'process.stop', label: 'Stop', description: 'Stop a running PM2 process from the Hub.' },
      { id: 'process.restart', label: 'Restart', description: 'Restart a PM2 process from the Hub.' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    description: 'Server-level operations beyond nginx.',
    children: [
      { id: 'system.nodeVersions', label: 'Manage Node.js versions', description: 'Install and switch Node.js versions through nvm.', comingSoon: true },
      { id: 'system.restartServer', label: 'Reboot the server', description: 'Reboot the whole machine.', comingSoon: true },
    ],
  },
];

export const COMING_SOON_IDS = PERMISSION_TREE.flatMap((g) =>
  g.children.filter((c) => c.comingSoon).map((c) => c.id)
);

export function seedPermissions(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const group of PERMISSION_TREE) {
    for (const child of group.children) map[child.id] = false;
  }
  for (const id of [
    'nginx.reload',
    'nginx.test',
    'nginx.config.view',
    'nginx.logs.view',
    'domains.create',
    'domains.edit',
    'domains.toggle',
    'ssl.renew',
    'ssl.renewAll',
  ]) {
    map[id] = true;
  }
  return map;
}

export function seedHub(permissions: Record<string, boolean>): HubStatus {
  return {
    linked: true,
    hubUrl: 'https://hub.example.com',
    serverId: 'srv_demo_01',
    permissions,
    tree: PERMISSION_TREE,
    comingSoon: COMING_SOON_IDS,
    connected: true,
    status: 'connected',
    lastError: null,
    attempts: 0,
    agentOwner: 'dashboard',
    agentReported: true,
    dataDir: '/var/lib/easy-devops',
    devDataDir: false,
  };
}
