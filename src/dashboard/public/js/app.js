/* global Vue, io */
const { createApp } = Vue;

// Default form structure matching DOMAIN_DEFAULTS
const DEFAULT_FORM = {
  name: '',
  port: 3000,
  backendHost: '127.0.0.1',
  upstreamType: 'http',
  www: false,
  wildcard: false,
  ssl: {
    enabled: false,
    certPath: '',
    keyPath: '',
    redirect: true,
    hsts: false,
    hstsMaxAge: 31536000,
  },
  performance: {
    maxBodySize: '10m',
    readTimeout: 60,
    connectTimeout: 10,
    proxyBuffers: false,
    gzip: true,
    gzipTypes: 'text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript',
  },
  security: {
    rateLimit: false,
    rateLimitRate: 10,
    rateLimitBurst: 20,
    securityHeaders: false,
    custom404: false,
    custom50x: false,
  },
  advanced: {
    accessLog: true,
    customLocations: '',
  },
  notifications: {
    domain_health: { enabled: true, channelIds: [] },
    cert_expiry:   { enabled: true, channelIds: [] },
    nginx_down:    { enabled: true, channelIds: [] },
  },
};

createApp({
  data() {
    return {
      theme: localStorage.getItem('ed-theme') || 'dark',
      accent: localStorage.getItem('ed-accent') || 'teal',
      sidebarCollapsed: localStorage.getItem('ed-sidebar') === 'true',
      authenticated: false,
      page: 'overview',

      login: {
        password: '', confirm: '', error: '', loading: false,
        // Replaced by minPasswordLength from GET /api/auth as soon as it
        // answers; this is only the value used before that first response.
        needsSetup: false, minLength: 6,
        // Offered only when the server says this request is local and the
        // dashboard listens on this machine only.
        canUseNoPassword: false,
        authMode: 'password',
      },

      navItems: [
        { id: 'overview', label: 'Overview', icon: '⚡' },
        { id: 'nginx', label: 'Nginx', icon: '🌐' },
        { id: 'ssl', label: 'SSL Certs', icon: '🔒' },
        { id: 'domains', label: 'Domains', icon: '🔗' },
        { id: 'processes', label: 'Processes', icon: '🧩' },
        { id: 'logs', label: 'Logs', icon: '📋' },
        { id: 'settings', label: 'Settings', icon: '⚙️' },
      ],

      // Background service (PM2) and the process list.
      svc: {
        status: null, loading: false, restarting: false, message: '', error: false,
      },
      processes: {
        apps: [], loading: false, pm2Installed: false, currentUser: '',
        busy: null, message: '', error: false,
        logsFor: null, logLines: [],
        confirm: null,
      },

      nginx: {
        status: null, loading: false,
        actionMsg: '', actionError: '',
        configs: [], selectedConfig: '',
        configContent: '', configSaving: false, configMsg: '',
        logs: [], logsLoading: false,
        configDropdownOpen: false,
      },

      ssl: {
        certs: [], loading: false, error: '', renewingDomain: null,
        showCreateForm: false,
        createDomain: '', createWww: false, createEmail: '',
        creating: false, createResult: null, createError: null,
        createMethod: 'http', // 'http' | 'dns'
        dnsWaiting: null, // { txtName, txtValue, domain } | null
        dnsConfirming: false, // true while confirm call is in-flight
      },

      // T017-T019: Updated domains state
      domainHealth: {}, // { [name]: true|false|null }

      domains: {
        list: [], loading: false, error: '',
        showForm: false,
        upstreamTypeOpen: false,
        editingName: null, // T017: null = adding, string = editing
        saving: false,
        dirty: false, // T019: Track unsaved changes
        form: JSON.parse(JSON.stringify(DEFAULT_FORM)), // T025: Nested v2 structure
        certMissing: null, // { certPath, keyPath, hint } set when POST /api/domains returns 422
        certCreating: false, // true while POST /api/ssl/create is in-flight
        certCreateError: null, // structured error from a failed cert creation
        certMethod: 'http', // 'http' | 'dns' — method selected in cert_missing section
        certDnsWaiting: null, // { txtName, txtValue, domain } while DNS two-phase is in progress
        certDnsConfirming: false, // true while /create-confirm call is in-flight
      },

      // T018: Collapsible section state
      sections: {
        basic: true,
        ssl: true,
        performance: false,
        security: false,
        advanced: false,
        notifications: false,
      },

      logs: {
        lines: [],
        activeLog: 'error', // 'error' | 'access'
        paused: false,
        socket: null,
      },

      settings: {
        dashboardPort: '', nginxDir: '', sslDir: '', acmeEmail: '',
        password: '', loading: false, msg: '', error: '',
        platform: 'linux', // T022: Platform from settings API
        dashboardBindAddress: '', bindsToLoopbackOnly: false,
        dashboardAuth: 'password', canUseNoPassword: false, hasPassword: false,
      },
      settingsTab: 'general', // 'general' | 'notifications' | 'hub'

      hub: {
        loading: false,
        status: {
          linked: false, connected: false, status: 'not_linked',
          hubUrl: null, serverId: null, permissions: {},
          tree: [], comingSoon: [],
          lastError: null, attempts: 0,
        },
        form: { connectionString: '' },
        msg: '',
        error: '',
        pollTimer: null,
      },

      permissions: {
        configured: false, loading: false, checking: false,
        commands: [], refusedDirs: [], msg: '', error: '',
      },

      backup: {
        restoring: false, msg: '', error: '',
      },

      channels: {
        list: [],
        loading: false,
        testingId: null,
        testResults: {},
      },
      channelModal: {
        open: false,
        editing: null, // null = add new, string = channel id being edited
        form: { name: '', type: 'discord', webhookUrl: '', botToken: '', chatId: '', message: '' },
        saving: false,
        error: '',
      },

      notifications: {
        items: [],      // { id, type, severity, message, domain?, timestamp }
        panelOpen: false,
        unread: 0,
      },
    };
  },

  computed: {
    isDark() { return this.theme === 'dark'; },
    expiringCount() { return this.ssl.certs.filter(c => c.daysLeft !== null && c.daysLeft < 30).length; },
    swalTheme() {
      // Create dynamically evaluated properties based on current CSS variables
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        background: 'var(--color-surface)',
        color: 'var(--color-text)',
        confirmButtonColor: rootStyle.getPropertyValue('--color-primary').trim(),
        cancelButtonColor: 'transparent',
        customClass: {
          confirmButton: 'btn btn-primary',
          cancelButton: 'btn btn-secondary',
          popup: 'swal2-popup'
        }
      };
    },
  },

  watch: {
    theme(val) {
      localStorage.setItem('ed-theme', val);
      document.documentElement.classList.toggle('dark', val === 'dark');
    },
    accent(val) {
      localStorage.setItem('ed-accent', val);
      document.documentElement.setAttribute('data-accent', val);
    },
    sidebarCollapsed(val) {
      localStorage.setItem('ed-sidebar', val);
    },

    'logs.lines'() {
      if (!this.logs.paused) {
        this.$nextTick(() => {
          const el = document.getElementById('log-output');
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    },

    // T019: Deep watch form for dirty tracking
    'domains.form': {
      handler() {
        if (this.domains.showForm) {
          this.domains.dirty = true;
        }
      },
      deep: true,
    },

    // T024: Auto-populate SSL paths when SSL is toggled on
    'domains.form.ssl.enabled'(newVal) {
      if (newVal) {
        this.autoPopulateCertPaths();
      }
    },

    // Wildcard: force DNS cert method when wildcard is enabled
    'domains.form.wildcard'(newVal) {
      if (newVal) {
        this.domains.certMethod = 'dns';
      }
    },
  },

  // T020: beforeunload guard for unsaved changes
  beforeMount() {
    window.addEventListener('beforeunload', (e) => {
      if (this.domains.dirty && this.domains.showForm) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  },

  async mounted() {
    document.documentElement.classList.toggle('dark', this.theme === 'dark');
    document.documentElement.setAttribute('data-accent', this.accent);

    // Check if already authenticated, and whether this is a first run.
    try {
      const r = await fetch('/api/auth');
      const d = await r.json();
      this.login.needsSetup = d.needsSetup === true;
      this.login.canUseNoPassword = d.canUseNoPassword === true;
      this.login.authMode = d.authMode || 'password';
      if (typeof d.minPasswordLength === 'number') this.login.minLength = d.minPasswordLength;
      if (d.authenticated) { this.authenticated = true; this.loadPage('overview'); }
    } catch { /* server may not be up yet */ }

    // Settings are behind the session now, so only load them once signed in.
    if (this.authenticated) await this.loadSettings();

    // Real-time nginx status via Socket.io
    // extraHeaders reaches the server because socket.io's default transport
    // order starts with HTTP polling, where headers can be set. Do NOT add
    // transports: ['websocket'] here — browsers cannot set headers on a
    // WebSocket upgrade, and the handshake would be refused.
    const socket = io({ extraHeaders: { 'X-EZ-Request': '1' } });
    socket.on('nginx:status', (status) => {
      this.nginx.status = status;
    });
    socket.on('notification:new', (n) => {
      this.addNotification(n);
    });
    socket.on('domain:health', (results) => {
      const map = {};
      for (const r of results) map[r.name] = r.up;
      this.domainHealth = map;
    });
    // A change applied by the Hub (or any other process) — refresh just the
    // affected section so the open tab does not show stale data.
    socket.on('local:changed', ({ section }) => {
      if (section === 'domains') {
        this.loadDomains();
        if (this.page === 'ssl') this.loadCerts();
      } else if (section === 'ssl') {
        this.loadCerts();
        this.loadDomains();
      } else if (section === 'nginx') {
        this.loadNginxStatus();
        if (this.page === 'nginx') this.loadNginxConfigs();
      }
      if (this.settingsTab === 'hub') this.loadHubStatus();
    });

    socket.on('logs:line', ({ line, logFile }) => {
      if (!this.logs.paused && logFile === this.logs.activeLog) {
        this.logs.lines.push(line);
        if (this.logs.lines.length > 500) this.logs.lines.shift();
      }
    });
    this.logs.socket = socket;
  },

  methods: {
    // ── Core API helper ────────────────────────────────────────────────────────
    async api(method, path, body) {
      const opts = {
        method,
        headers: {
          'Content-Type': 'application/json',
          // Proves the request came from the dashboard's own page rather than
          // another website in this browser: a cross-site form cannot set a
          // custom header, and a cross-site fetch that tries triggers a CORS
          // preflight the server never approves. Required on every
          // state-changing request — see dashboard/lib/localRequest.js.
          'X-EZ-Request': '1',
        },
      };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const r = await fetch(path, opts);
      const data = await r.json().catch(() => ({}));

      // Any 401 means the session is gone — expired, or the server restarted
      // with a new session secret. Drop straight back to the login screen
      // instead of leaving a half-dead page showing stale data.
      if (r.status === 401 && path !== '/api/login' && path !== '/api/setup') {
        this.handleUnauthorized(data);
      }

      return { ok: r.ok, status: r.status, data };
    },

    /** Returns the UI to the login screen after the session was refused. */
    handleUnauthorized(data) {
      if (this.authenticated) this.login.error = 'Your session ended. Please sign in again.';
      this.authenticated = false;
      this.login.password = '';
      this.login.confirm = '';
      if (data && data.needsSetup === true) this.login.needsSetup = true;
    },

    // ── Theme ─────────────────────────────────────────────────────────────────
    toggleTheme() { this.theme = this.theme === 'dark' ? 'light' : 'dark'; },
    setAccent(color) { this.accent = color; },

    // ── Auth ──────────────────────────────────────────────────────────────────
    async doLogin() {
      this.login.loading = true; this.login.error = '';
      const r = await this.api('POST', '/api/login', { password: this.login.password });
      this.login.loading = false;

      if (r.ok) {
        this.authenticated = true;
        this.login.password = '';
        this.login.confirm = '';
        this.login.needsSetup = false;
        await this.loadSettings();
        this.loadPage('overview');
        return;
      }

      // The server decides when setup is needed; the page follows it.
      if (r.data && r.data.needsSetup === true) this.login.needsSetup = true;
      this.login.error = r.data.error || 'Invalid password';
    },

    /**
     * First run: run without a password.
     *
     * Only reachable when the server reported canUseNoPassword, which means
     * the dashboard listens on this machine only AND this request came from
     * this machine. The server re-checks both; this is just the button.
     */
    async doSetupNoPassword() {
      this.login.error = '';
      this.login.loading = true;
      const r = await this.api('POST', '/api/setup', { mode: 'none' });
      this.login.loading = false;

      if (r.ok) {
        this.authenticated = true;
        this.login.needsSetup = false;
        this.login.authMode = 'none';
        await this.loadSettings();
        this.loadPage('overview');
        return;
      }

      this.login.error = r.data.error || 'Could not save that choice';
    },

    /** First run: set the initial password, which also signs the user in. */
    async doSetup() {
      this.login.error = '';

      if (this.login.password.length < this.login.minLength) {
        this.login.error = 'The password must be at least ' + this.login.minLength + ' characters.';
        return;
      }
      if (this.login.password !== this.login.confirm) {
        this.login.error = 'The two passwords do not match.';
        return;
      }

      this.login.loading = true;
      const r = await this.api('POST', '/api/setup', { password: this.login.password });
      this.login.loading = false;

      if (r.ok) {
        this.authenticated = true;
        this.login.password = '';
        this.login.confirm = '';
        this.login.needsSetup = false;
        await this.loadSettings();
        this.loadPage('overview');
        return;
      }

      this.login.error = r.data.error || 'Could not set the password';
    },

    async doLogout() {
      await this.api('POST', '/api/logout');
      this.authenticated = false;
      this.login.password = '';
      this.login.confirm = '';
      this.login.error = '';
    },

    // ── Navigation (T021: Nav click guard) ────────────────────────────────────
    async navigateTo(pageId) {
      if (this.domains.dirty && this.domains.showForm) {
        const { isConfirmed } = await Swal.fire({
          title: 'Unsaved changes',
          text: 'Discard changes and continue?',
          icon: 'warning',
          showCancelButton: true,
          confirmButtonText: 'Discard',
          cancelButtonText: 'Stay',
          ...this.swalTheme,
        });
        if (!isConfirmed) return;
        this.resetDomainForm();
      }
      await this.loadPage(pageId);
    },

    async loadPage(p) {
      if (this.page === 'logs' && p !== 'logs') this.unsubscribeLogs();
      // The hub status poll only exists for the settings page; leaving it must
      // not leave a timer re-polling in the background.
      if (p !== 'settings') this.stopHubPoll();
      this.page = p;
      if (p === 'overview') {
        await Promise.all([this.loadNginxStatus(), this.loadSSL(), this.loadDomains()]);
      } else if (p === 'nginx') {
        await Promise.all([this.loadNginxStatus(), this.loadNginxConfigs(), this.loadNginxLogs()]);
      } else if (p === 'ssl') { await this.loadSSL(); }
      else if (p === 'domains') { await this.loadDomains(); }
      else if (p === 'logs') { this.subscribeToLogs(this.logs.activeLog); }
      else if (p === 'processes') { await this.loadProcessesPage(); }
      else if (p === 'settings') { await Promise.all([this.loadSettings(), this.loadPermissionsStatus(), this.loadChannels(), this.loadHubStatus(), this.loadServiceStatus()]); }
    },

    // ── Collapsible Sections ────────────────────────────────────────────
    toggleSection(sectionId) {
      this.sections[sectionId] = !this.sections[sectionId];
    },

    // ── Background service + processes ────────────────────────────────────────

    /** Both panels on the Processes page come from two independent reads. */
    async loadProcessesPage() {
      await Promise.all([this.loadServiceStatus(), this.loadProcesses()]);
    },

    async loadServiceStatus() {
      this.svc.loading = true;
      const r = await this.api('GET', '/api/service');
      this.svc.loading = false;
      if (r.ok) this.svc.status = r.data;
    },

    async loadProcesses() {
      this.processes.loading = true;
      const r = await this.api('GET', '/api/processes');
      this.processes.loading = false;
      if (!r.ok) {
        this.processes.error = true;
        this.processes.message = r.data?.error || 'Could not read the process list';
        return;
      }
      this.processes.apps = r.data.apps || [];
      this.processes.pm2Installed = Boolean(r.data.pm2?.installed);
      this.processes.currentUser = r.data.currentUser || '';
      this.processes.error = false;
      this.processes.message = '';
    },

    describeBoot(status) {
      if (!status) return 'No';
      // null means the init system could not be inspected (non-systemd Linux);
      // showing "No" there would be a confident lie.
      if (status.enabledOnBoot === null) return 'Unknown';
      if (!status.enabledOnBoot) return 'No';
      if (status.bootMode === 'logon') return 'At logon';
      if (status.bootMode === 'boot') return 'At startup';
      return 'Yes';
    },

    formatBytes(bytes) {
      if (bytes === null || bytes === undefined) return '—';
      if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
      return Math.round(bytes / (1024 * 1024)) + ' MB';
    },

    formatDuration(ms) {
      if (ms === null || ms === undefined || ms < 0) return '—';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ' + (m % 60) + 'm';
      return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    },

    /**
     * Acts on one PM2 process.
     *
     * Anything Easy DevOps did not create asks first: the user may be looking
     * at an unrelated production app that happens to share this PM2.
     */
    async processAction(app, action) {
      if (!app.managed && (action === 'stop' || action === 'restart')) {
        this.processes.confirm = { name: app.name, action };
        return;
      }
      await this.runProcessAction(app.name, action);
    },

    async runConfirmedProcessAction() {
      const pending = this.processes.confirm;
      this.processes.confirm = null;
      if (pending) await this.runProcessAction(pending.name, pending.action);
    },

    async runProcessAction(name, action) {
      this.processes.busy = name;
      this.processes.message = '';
      const r = await this.api('POST', `/api/processes/${encodeURIComponent(name)}/${action}`);
      this.processes.busy = null;

      if (r.ok) {
        this.processes.error = false;
        this.processes.message = `${name}: ${action} done`;
      } else {
        this.processes.error = true;
        this.processes.message = r.data?.error || `Could not ${action} ${name}`;
      }
      await this.loadProcessesPage();
    },

    async showProcessLogs(app) {
      this.processes.busy = app.name;
      const r = await this.api('GET', `/api/processes/${encodeURIComponent(app.name)}/logs?lines=200`);
      this.processes.busy = null;
      if (r.ok) {
        this.processes.logsFor = app.name;
        this.processes.logLines = r.data.lines || [];
      } else {
        this.processes.error = true;
        this.processes.message = r.data?.error || 'Could not read the logs';
      }
    },

    /**
     * Restarts the service. Safe from the dashboard on both platforms: it needs
     * no elevation and no password prompt, unlike installing the boot task.
     */
    async restartService() {
      this.svc.restarting = true;
      this.svc.message = '';
      const r = await this.api('POST', '/api/service/restart');
      this.svc.restarting = false;

      if (r.ok) {
        this.svc.error = false;
        this.svc.message = 'Service restarted. The dashboard may take a moment to come back.';
      } else {
        this.svc.error = true;
        this.svc.message = r.data?.error || 'Could not restart the service';
      }
      await this.loadServiceStatus();
    },

    // ── Nginx ─────────────────────────────────────────────────────────────────
    async loadNginxStatus() {
      this.nginx.loading = true;
      const r = await this.api('GET', '/api/nginx/status');
      this.nginx.loading = false;
      if (r.ok) this.nginx.status = r.data;
    },

    async nginxAction(action) {
      this.nginx.actionMsg = ''; this.nginx.actionError = '';
      const r = await this.api('POST', `/api/nginx/${action}`);
      if (r.ok) { this.nginx.actionMsg = r.data.output || `${action} successful`; await this.loadNginxStatus(); }
      else { this.nginx.actionError = r.data.output || r.data.error || `${action} failed`; }
    },

    async loadNginxConfigs() {
      const r = await this.api('GET', '/api/nginx/configs');
      if (r.ok) this.nginx.configs = r.data;
    },

    async selectConfig(filename) {
      if (!filename) return;
      this.nginx.configMsg = '';
      const r = await this.api('GET', `/api/nginx/config/${filename}`);
      if (r.ok) this.nginx.configContent = r.data.content;
    },

    async saveNginxConfig() {
      if (!this.nginx.selectedConfig) return;
      this.nginx.configSaving = true; this.nginx.configMsg = '';
      const r = await this.api('POST', `/api/nginx/config/${this.nginx.selectedConfig}`, { content: this.nginx.configContent });
      this.nginx.configSaving = false;
      this.nginx.configMsg = r.ok
        ? 'Saved — config test passed ✓'
        : (r.data.output || r.data.error || 'Save failed');
    },

    async loadNginxLogs() {
      this.nginx.logsLoading = true;
      const r = await this.api('GET', '/api/nginx/logs');
      this.nginx.logsLoading = false;
      if (r.ok) this.nginx.logs = r.data.lines || [];
    },

    // ── SSL ───────────────────────────────────────────────────────────────────
    async loadSSL() {
      this.ssl.loading = true; this.ssl.error = '';
      const r = await this.api('GET', '/api/ssl');
      this.ssl.loading = false;
      if (r.ok) this.ssl.certs = Array.isArray(r.data) ? r.data : [];
      else this.ssl.error = r.data.error || 'Failed to load certificates';
    },

    async renewCert(domain) {
      this.ssl.renewingDomain = domain;
      await this.api('POST', `/api/ssl/renew/${domain}`);
      this.ssl.renewingDomain = null;
      await this.loadSSL();
    },

    async renewAll() {
      this.ssl.renewingDomain = 'all';
      await this.api('POST', '/api/ssl/renew-all');
      this.ssl.renewingDomain = null;
      await this.loadSSL();
    },

    async createCert() {
      if (!this.ssl.createDomain.trim()) return;
      this.ssl.creating = true;
      this.ssl.createResult = null;
      this.ssl.createError = null;
      const r = await this.api('POST', '/api/ssl/create', {
        domain: this.ssl.createDomain.trim(),
        www: this.ssl.createWww,
        email: this.ssl.createEmail.trim(),
        validationMethod: this.ssl.createMethod,
      });
      this.ssl.creating = false;
      if (r.status === 202 && r.data.status === 'waiting_dns') {
        this.ssl.dnsWaiting = r.data; // { domain, txtName, txtValue }
        // Do not hide the form or clear the domain — show DNS waiting state
      } else if (r.ok) {
        this.ssl.createResult = r.data;
        this.ssl.createDomain = '';
        this.ssl.createWww = false;
        this.ssl.createEmail = '';
        await this.loadSSL();
      } else if (r.status === 400) {
        this.ssl.createError = { step: 'email configuration', cause: r.data.hint, consequence: 'Configure acmeEmail in settings or provide email.', nginxRunning: true };
      } else if (r.status === 409) {
        this.ssl.createError = { step: 'port 80 check', cause: r.data.detail, consequence: r.data.hint, nginxRunning: true };
      } else {
        this.ssl.createError = r.data.error || { step: 'certificate issuance', cause: 'Unknown error', consequence: 'No certificate was issued.' };
      }
    },

    async confirmDns() {
      if (!this.ssl.dnsWaiting) return;
      this.ssl.dnsConfirming = true;
      const r = await this.api('POST', '/api/ssl/create-confirm', { domain: this.ssl.dnsWaiting.domain });
      this.ssl.dnsConfirming = false;
      if (r.ok) {
        this.ssl.createResult = r.data;
        this.ssl.dnsWaiting = null;
        this.ssl.createDomain = '';
        this.ssl.createWww = false;
        this.ssl.createEmail = '';
        await this.loadSSL();
      } else {
        this.ssl.createError = r.data.error || { step: 'DNS validation', cause: 'Certificate issuance failed after DNS confirmation.', consequence: 'No certificate was issued.' };
        this.ssl.dnsWaiting = null;
      }
    },

    async cancelDns() {
      if (!this.ssl.dnsWaiting) return;
      await this.api('POST', '/api/ssl/create-cancel', { domain: this.ssl.dnsWaiting.domain });
      this.ssl.dnsWaiting = null;
    },

    certStatus(cert) {
      if (cert.daysLeft === null || cert.daysLeft === undefined) return 'Unknown';
      if (cert.daysLeft > 30) return 'Healthy';
      if (cert.daysLeft >= 10) return 'Expiring';
      return 'Critical';
    },
    certDaysColor(cert) {
      if (cert.daysLeft === null || cert.daysLeft === undefined) return 'text-gray-400';
      if (cert.daysLeft > 30) return 'text-green-500';
      if (cert.daysLeft >= 10) return 'text-yellow-500';
      return 'text-red-500';
    },
    certBadgeClass(cert) {
      const s = this.certStatus(cert);
      if (s === 'Healthy') return 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400';
      if (s === 'Expiring') return 'bg-yellow-100 dark:bg-yellow-950/60 text-yellow-700 dark:text-yellow-400';
      if (s === 'Critical') return 'bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-400';
      return 'bg-gray-100 dark:bg-gray-800 text-gray-500';
    },
    certBadgeType(cert) {
      const s = this.certStatus(cert);
      if (s === 'Healthy') return 'success';
      if (s === 'Expiring') return 'warning';
      if (s === 'Critical') return 'danger';
      return 'neutral';
    },

    // ── Domains ───────────────────────────────────────────────────────
    async loadDomains() {
      this.domains.loading = true;
      const r = await this.api('GET', '/api/domains');
      this.domains.loading = false;
      if (r.ok) this.domains.list = r.data;
    },

    async toggleDomainForm() {
      if (this.domains.showForm && this.domains.dirty) {
        const { isConfirmed } = await Swal.fire({
          title: 'Unsaved changes',
          text: 'Discard changes and close?',
          icon: 'warning',
          showCancelButton: true,
          confirmButtonText: 'Discard',
          cancelButtonText: 'Stay',
          ...this.swalTheme,
        });
        if (!isConfirmed) return;
      }
      this.domains.showForm = !this.domains.showForm;
      if (this.domains.showForm) {
        await this.loadChannels();
      } else {
        this.resetDomainForm();
      }
    },

    resetDomainForm() {
      this.domains.form = JSON.parse(JSON.stringify(DEFAULT_FORM));
      this.domains.editingName = null;
      this.domains.dirty = false;
      this.domains.error = '';
      this.domains.certMissing = null;
      this.domains.certCreateError = null;
      this.domains.certMethod = 'http';
      this.domains.certDnsWaiting = null;
      this.domains.certDnsConfirming = false;
      // Reset sections
      this.sections = {
        basic: true,
        ssl: true,
        performance: false,
        security: false,
        advanced: false,
        notifications: false,
      };
    },

    async editDomain(name) {
      if (this.domains.dirty && this.domains.showForm) {
        const { isConfirmed } = await Swal.fire({
          title: 'Unsaved changes',
          text: 'Discard changes and edit this domain?',
          icon: 'warning',
          showCancelButton: true,
          confirmButtonText: 'Discard',
          cancelButtonText: 'Stay',
          ...this.swalTheme,
        });
        if (!isConfirmed) return;
      }

      // Ensure channels are loaded for the notifications section
      await this.loadChannels();

      // Fetch domain data
      const r = await this.api('GET', `/api/domains`);
      if (!r.ok) {
        this.domains.error = 'Failed to load domain data';
        return;
      }

      const domain = r.data.find(d => d.name === name);
      if (!domain) {
        this.domains.error = 'Domain not found';
        return;
      }

      // Populate form with domain data
      this.domains.form = {
        name: domain.name,
        port: domain.port,
        backendHost: domain.backendHost || '127.0.0.1',
        upstreamType: domain.upstreamType || 'http',
        www: domain.www || false,
        wildcard: domain.wildcard || false,
        ssl: {
          enabled: domain.ssl?.enabled || false,
          certPath: domain.ssl?.certPath || '',
          keyPath: domain.ssl?.keyPath || '',
          redirect: domain.ssl?.redirect ?? true,
          hsts: domain.ssl?.hsts || false,
          hstsMaxAge: domain.ssl?.hstsMaxAge || 31536000,
        },
        performance: {
          maxBodySize: domain.performance?.maxBodySize || '10m',
          readTimeout: domain.performance?.readTimeout || 60,
          connectTimeout: domain.performance?.connectTimeout || 10,
          proxyBuffers: domain.performance?.proxyBuffers || false,
          gzip: domain.performance?.gzip ?? true,
          gzipTypes: domain.performance?.gzipTypes || DEFAULT_FORM.performance.gzipTypes,
        },
        security: {
          rateLimit: domain.security?.rateLimit || false,
          rateLimitRate: domain.security?.rateLimitRate || 10,
          rateLimitBurst: domain.security?.rateLimitBurst || 20,
          securityHeaders: domain.security?.securityHeaders || false,
          custom404: domain.security?.custom404 || false,
          custom50x: domain.security?.custom50x || false,
        },
        advanced: {
          accessLog: domain.advanced?.accessLog ?? true,
          customLocations: domain.advanced?.customLocations || '',
        },
        notifications: {
          domain_health: domain.notifications?.domain_health ?? { enabled: true, channelIds: [] },
          cert_expiry:   domain.notifications?.cert_expiry   ?? { enabled: true, channelIds: [] },
          nginx_down:    domain.notifications?.nginx_down    ?? { enabled: true, channelIds: [] },
        },
      };

      this.domains.editingName = name;
      this.domains.showForm = true;
      this.domains.dirty = false;

      // Expand all sections for editing
      this.sections = {
        basic: true,
        ssl: true,
        performance: true,
        security: true,
        advanced: true,
        notifications: true,
      };
    },

    async saveDomain() {
      this.domains.error = '';
      this.domains.saving = true;

      const method = this.domains.editingName ? 'PUT' : 'POST';
      const url = this.domains.editingName
        ? `/api/domains/${encodeURIComponent(this.domains.editingName)}`
        : '/api/domains';

      const r = await this.api(method, url, this.domains.form);
      this.domains.saving = false;

      if (r.ok) {
        this.domains.showForm = false;
        this.domains.dirty = false;
        this.domains.editingName = null;
        this.resetDomainForm();
        await this.loadDomains();
      } else if (r.status === 422 && r.data.error === 'cert_missing') {
        this.domains.certMissing = r.data;
        this.domains.certCreateError = null;
      } else {
        this.domains.error = r.data.error || 'Failed to save domain';
      }
    },

    async createCertAndRetry() {
      this.domains.certCreating = true;
      this.domains.certCreateError = null;
      const domain = this.domains.form.name;
      const www = this.domains.form.www;
      const r = await this.api('POST', '/api/ssl/create', { domain, www, validationMethod: this.domains.certMethod });
      this.domains.certCreating = false;

      if (r.status === 202 && r.data.status === 'waiting_dns') {
        this.domains.certDnsWaiting = r.data; // { domain, txtName, txtValue }
        // Stay in cert_missing section — show DNS waiting state
      } else if (r.ok) {
        // Update cert paths in the form with what was actually written
        this.domains.form.ssl.certPath = r.data.certPath;
        this.domains.form.ssl.keyPath = r.data.keyPath;
        this.domains.certMissing = null;
        // Retry the domain save now that the cert exists
        await this.saveDomain();
      } else if (r.status === 400) {
        this.domains.certCreateError = { step: 'email configuration', cause: r.data.hint, consequence: 'Configure acmeEmail in settings.', nginxRunning: true };
      } else if (r.status === 409) {
        this.domains.certCreateError = { step: 'port 80 check', cause: r.data.detail, consequence: r.data.hint, nginxRunning: true };
      } else {
        this.domains.certCreateError = r.data.error || { step: 'certificate issuance', cause: 'Unknown error', consequence: 'No certificate was issued.' };
      }
    },

    async confirmCertDns() {
      if (!this.domains.certDnsWaiting) return;
      this.domains.certDnsConfirming = true;
      const r = await this.api('POST', '/api/ssl/create-confirm', { domain: this.domains.certDnsWaiting.domain });
      this.domains.certDnsConfirming = false;
      if (r.ok) {
        this.domains.form.ssl.certPath = r.data.certPath;
        this.domains.form.ssl.keyPath = r.data.keyPath;
        this.domains.certDnsWaiting = null;
        this.domains.certMissing = null;
        await this.saveDomain();
      } else {
        this.domains.certCreateError = r.data.error || { step: 'DNS validation', cause: 'Certificate issuance failed after DNS confirmation.', consequence: 'No certificate was issued.' };
        this.domains.certDnsWaiting = null;
      }
    },

    async cancelCertDns() {
      if (!this.domains.certDnsWaiting) return;
      await this.api('POST', '/api/ssl/create-cancel', { domain: this.domains.certDnsWaiting.domain });
      this.domains.certDnsWaiting = null;
    },

    disableSslAndSave() {
      this.domains.form.ssl.enabled = false;
      this.domains.certMissing = null;
      this.domains.certCreateError = null;
      this.domains.certDnsWaiting = null;
      this.saveDomain();
    },

    dismissCertMissing() {
      this.domains.certMissing = null;
      this.domains.certCreateError = null;
      this.domains.certDnsWaiting = null;
    },

    async deleteDomain(name) {
      const domain = this.domains.list.find(d => d.name === name);
      const hasCert = domain?.ssl?.enabled;
      const { isConfirmed, value: deleteCertChecked } = await Swal.fire({
        title: `Delete "${name}"?`,
        text: 'This cannot be undone.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Delete',
        cancelButtonText: 'Cancel',
        input: hasCert ? 'checkbox' : undefined,
        inputValue: 0,
        inputPlaceholder: 'Also delete SSL certificate files',
        ...this.swalTheme,
      });
      if (!isConfirmed) return;
      const deleteCert = hasCert && deleteCertChecked === 1;
      await this.api('DELETE', `/api/domains/${name}${deleteCert ? '?deleteCert=true' : ''}`);
      await this.loadDomains();
    },

    async reloadDomain(name) {
      await this.api('POST', `/api/domains/${name}/reload`);
    },

    async toggleDomain(name) {
      const domain = this.domains.list.find(d => d.name === name);
      const isEnabled = domain?.enabled !== false;
      const action = isEnabled ? 'disable' : 'enable';
      const { isConfirmed } = await Swal.fire({
        title: `${isEnabled ? 'Disable' : 'Enable'} "${name}"?`,
        text: isEnabled
          ? 'Nginx will stop serving this domain until re-enabled.'
          : 'Nginx will resume serving this domain.',
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: isEnabled ? 'Disable' : 'Enable',
        cancelButtonText: 'Cancel',
        ...this.swalTheme,
      });
      if (!isConfirmed) return;
      const r = await this.api('PUT', `/api/domains/${name}/toggle`);
      if (!r.ok) {
        await Swal.fire({ title: 'Error', text: r.data.error || `Failed to ${action} domain`, icon: 'error', ...this.swalTheme });
      }
      await this.loadDomains();
    },

    // T024: Auto-populate SSL paths when SSL is enabled
    autoPopulateCertPaths() {
      if (this.domains.form.ssl.enabled) {
        if (!this.domains.form.ssl.certPath || !this.domains.form.ssl.keyPath) {
          const domain = this.domains.form.name;
          if (domain) {
            const platform = this.settings.platform;
            // Always forward slashes, including on Windows: nginx reads a
            // backslash as an escape character, so C:\nginx\test\... would
            // have its \n and \t turned into a newline and a tab.
            // Use the configured sslDir — that is where certs are issued.
            const fallback = platform === 'win32' ? 'C:/easy-devops/ssl' : '/etc/easy-devops/ssl';
            const base = String(this.settings.sslDir || fallback)
              .replace(/\\/g, '/')
              .replace(/\/{2,}/g, '/')
              .replace(/\/+$/, '');
            this.domains.form.ssl.certPath = `${base}/${domain}/fullchain.pem`;
            this.domains.form.ssl.keyPath = `${base}/${domain}/privkey.pem`;
          }
        }
      }
    },

    // ── Settings (T022: Updated to capture platform) ───────────────────────────
    async loadSettings() {
      this.settings.loading = true;
      const r = await this.api('GET', '/api/settings');
      this.settings.loading = false;
      if (r.ok) {
        this.settings.dashboardPort = r.data.dashboardPort;
        this.settings.nginxDir = r.data.nginxDir;
        this.settings.sslDir = r.data.sslDir;
        this.settings.acmeEmail = r.data.acmeEmail || '';
        this.settings.platform = r.data.platform || 'linux'; // T022
        this.settings.dashboardBindAddress = r.data.dashboardBindAddress || '';
        this.settings.bindsToLoopbackOnly = r.data.bindsToLoopbackOnly === true;
        this.settings.dashboardAuth = r.data.dashboardAuth || 'password';
        this.settings.canUseNoPassword = r.data.canUseNoPassword === true;
        this.settings.hasPassword = r.data.hasPassword === true;
      }
    },

    async loadPermissionsStatus() {
      if (this.settings.platform === 'win32') { this.permissions.configured = true; return; }
      const r = await this.api('GET', '/api/settings/permissions');
      if (r.ok) this.permissions.configured = r.data.configured === true;
    },

    // ── Hub ──────────────────────────────────────────────────────────────────────
    hubStatusLabel() {
      const map = {
        not_linked:  'Not linked',
        connecting:  'Connecting…',
        connected:   'Online',
        rejected:    'Rejected by hub',
        unreachable: 'Hub unreachable',
      };
      return map[this.hub.status.status] || 'Unknown';
    },

    hubStatusDotClass() {
      const map = {
        connected:   'bg-green-500',
        connecting:  'bg-yellow-500',
        unreachable: 'bg-yellow-500',
        rejected:    'bg-red-500',
        not_linked:  'bg-slate-500',
      };
      return map[this.hub.status.status] || 'bg-slate-500';
    },

    async loadHubStatus() {
      const r = await this.api('GET', '/api/hub/status');
      if (r.ok) {
        this.hub.status = {
          linked: r.data.linked,
          connected: r.data.connected,
          status: r.data.status || 'not_linked',
          hubUrl: r.data.hubUrl,
          serverId: r.data.serverId,
          permissions: r.data.permissions || {},
          tree: Array.isArray(r.data.tree) ? r.data.tree : [],
          comingSoon: Array.isArray(r.data.comingSoon) ? r.data.comingSoon : [],
          lastError: r.data.lastError || null,
          attempts: r.data.attempts || 0,
        };
        // Keep polling only while the outcome is still undecided.
        // Keep polling while the outcome can still change on its own.
        // 'unreachable' is included because the agent retries in the
        // background and can recover without any user action — without this
        // the tab would keep showing "Hub unreachable" after it reconnected.
        // 'rejected' and 'not_linked' need the user, so polling stops there.
        if (this.hub.status.status === 'connecting') this.scheduleHubPoll(2000);
        else if (this.hub.status.status === 'unreachable') this.scheduleHubPoll(15000);
        else this.stopHubPoll();
      }
    },

    scheduleHubPoll(delayMs = 2000) {
      this.stopHubPoll();
      this.hub.pollTimer = setTimeout(() => this.loadHubStatus(), delayMs);
    },

    stopHubPoll() {
      if (this.hub.pollTimer) {
        clearTimeout(this.hub.pollTimer);
        this.hub.pollTimer = null;
      }
    },

    async connectHubAgent() {
      this.hub.loading = true;
      this.hub.msg = '';
      this.hub.error = '';
      try {
        const r = await this.api('POST', '/api/hub/connect', {
          connectionString: this.hub.form.connectionString,
        });
        if (r.ok) {
          this.hub.form.connectionString = '';
          this.hub.msg = 'Connection string saved. Connecting to the hub…';
          await this.loadHubStatus();
        } else {
          this.hub.error = r.data?.error || 'Failed to connect to the hub';
        }
      } catch (e) {
        // fetch() rejects when the dashboard is unreachable; without this the
        // button would stay disabled forever.
        this.hub.error = 'Could not reach the dashboard. Please try again.';
      } finally {
        this.hub.loading = false;
      }
    },

    async unlinkHub() {
      if (!confirm('Unlink this server from the hub? The hub will stop receiving data from this server.')) return;
      this.hub.loading = true;
      this.hub.msg = '';
      this.hub.error = '';
      try {
        const r = await this.api('DELETE', '/api/hub/link');
        if (r.ok) {
          this.stopHubPoll();
          this.hub.status = {
            linked: false, connected: false, status: 'not_linked',
            hubUrl: null, serverId: null, permissions: {},
            lastError: null, attempts: 0,
          };
          this.hub.form.connectionString = '';
          this.hub.msg = 'Unlinked from hub.';
        } else {
          this.hub.error = r.data?.error || 'Failed to unlink from the hub';
        }
      } catch (e) {
        this.hub.error = 'Could not reach the dashboard. Please try again.';
      } finally {
        this.hub.loading = false;
      }
    },

    // ── Permission tree ───────────────────────────────────────────────────────

    /** 'on' | 'off' | 'partial' for a group's checkbox. */
    hubGroupState(group) {
      const grantable = (group.children || []).filter(c => !c.comingSoon);
      if (grantable.length === 0) return 'off';
      const on = grantable.filter(c => this.hub.status.permissions[c.id] === true).length;
      if (on === 0) return 'off';
      if (on === grantable.length) return 'on';
      return 'partial';
    },

    hubGroupChecked(group) { return this.hubGroupState(group) === 'on'; },
    hubGroupIndeterminate(group) { return this.hubGroupState(group) === 'partial'; },

    /** Toggling a group sets every grantable child the same way. */
    async toggleHubGroup(group) {
      const turnOn = this.hubGroupState(group) !== 'on';
      for (const child of group.children || []) {
        if (child.comingSoon) continue;
        this.hub.status.permissions[child.id] = turnOn;
      }
      await this.persistHubPermissions({ groups: { [group.id]: turnOn } });
    },

    async toggleHubPermission(child) {
      if (child.comingSoon) return;
      const next = !this.hub.status.permissions[child.id];
      this.hub.status.permissions[child.id] = next;
      await this.persistHubPermissions({ [child.id]: next });
    },

    async persistHubPermissions(payload) {
      this.hub.error = '';
      const r = await this.api('PUT', '/api/hub/permissions', payload);
      if (r.ok) {
        // Trust the server's normalised answer over local optimism.
        this.hub.status.permissions = r.data.permissions || {};
      } else {
        this.hub.error = r.data?.error || 'Failed to save permissions';
        await this.loadHubStatus();
      }
    },

    hubGrantedCount() {
      return Object.values(this.hub.status.permissions || {}).filter(Boolean).length;
    },

    async loadChannels() {
      this.channels.loading = true;
      const r = await this.api('GET', '/api/settings/channels');
      this.channels.loading = false;
      if (r.ok) this.channels.list = Array.isArray(r.data) ? r.data : [];
    },

    async setupPermissions() {
      this.permissions.loading = true; this.permissions.msg = ''; this.permissions.error = '';
      // The dashboard never receives a sudo password: the endpoint takes no
      // body and answers with the commands the operator runs themselves.
      const r = await this.api('POST', '/api/settings/permissions/setup');
      this.permissions.loading = false;
      const d = r.data || {};
      this.permissions.commands = Array.isArray(d.commands) ? d.commands : [];
      this.permissions.refusedDirs = Array.isArray(d.refusedDirs) ? d.refusedDirs : [];
      if (typeof d.configured === 'boolean') this.permissions.configured = d.configured;

      if (!r.ok) {
        this.permissions.error = d.error || 'Could not prepare the setup commands';
      } else if (this.permissions.configured) {
        this.permissions.msg = 'Permissions configured ✓';
      } else if (this.permissions.commands.length) {
        this.permissions.msg = '';
      } else {
        this.permissions.error = 'No setup commands were returned';
      }
    },

    async checkPermissionsAgain() {
      this.permissions.checking = true; this.permissions.msg = ''; this.permissions.error = '';
      const r = await this.api('GET', '/api/settings/permissions');
      this.permissions.checking = false;
      if (!r.ok) {
        this.permissions.error = r.data?.error || 'Could not read the permissions status';
        return;
      }
      this.permissions.configured = r.data.configured === true;
      this.permissions.msg = this.permissions.configured
        ? 'Permissions configured ✓'
        : 'Still not configured — run the commands above in a terminal on the server.';
    },

    async copyPermissionCommands() {
      const text = this.permissions.commands.join('\n');
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        this.permissions.msg = 'Commands copied to the clipboard';
      } catch {
        this.permissions.error = 'Copy failed — select the commands and copy them manually.';
      }
    },

    // ── Logs ──────────────────────────────────────────────────────────────────
    subscribeToLogs(logFile) {
      if (!this.logs.socket) return;
      this.logs.lines = [];
      this.logs.activeLog = logFile;
      this.logs.paused = false;
      this.logs.socket.emit('logs:subscribe', { logFile });
    },
    switchLog(logFile) {
      this.subscribeToLogs(logFile);
    },
    unsubscribeLogs() {
      if (this.logs.socket) this.logs.socket.emit('logs:unsubscribe');
    },

    // ── Notifications ─────────────────────────────────────────────────────────
    addNotification(n) {
      // Deduplicate by id — replace if same id already exists
      const idx = this.notifications.items.findIndex(i => i.id === n.id);
      if (idx !== -1) {
        this.notifications.items.splice(idx, 1, n);
      } else {
        this.notifications.items.unshift(n);
        if (!this.notifications.panelOpen) this.notifications.unread++;
      }
    },
    toggleNotificationsPanel() {
      this.notifications.panelOpen = !this.notifications.panelOpen;
      if (this.notifications.panelOpen) this.notifications.unread = 0;
    },
    clearNotifications() {
      this.notifications.items = [];
      this.notifications.unread = 0;
    },
    notifIcon(type) {
      if (type === 'nginx_down') return '🔴';
      if (type === 'cert_expiry') return '🔒';
      if (type === 'domain_down') return '⚠️';
      return '🔔';
    },

    // ── Backup & Restore ──────────────────────────────────────────────────────
    exportBackup() {
      window.location.href = '/api/settings/backup';
    },
    async importBackup(event) {
      const file = event.target.files[0];
      if (!file) return;
      this.backup.msg = ''; this.backup.error = '';
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        this.backup.error = 'Invalid file — could not parse JSON.';
        event.target.value = '';
        return;
      }
      const { isConfirmed } = await Swal.fire({
        title: 'Restore backup?',
        text: 'This will overwrite your current configuration and domains list.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Restore',
        cancelButtonText: 'Cancel',
        ...this.swalTheme,
      });
      event.target.value = '';
      if (!isConfirmed) return;
      this.backup.restoring = true;
      const r = await this.api('POST', '/api/settings/restore', data);
      this.backup.restoring = false;
      if (r.ok) {
        this.backup.msg = 'Restored successfully. Reload the page to see changes.';
        await this.loadSettings();
        await this.loadDomains();
      } else {
        this.backup.error = r.data?.error || 'Restore failed';
      }
    },

    async saveSettings() {
      this.settings.loading = true; this.settings.msg = ''; this.settings.error = '';
      const payload = {
        dashboardPort: this.settings.dashboardPort,
        nginxDir: this.settings.nginxDir,
        sslDir: this.settings.sslDir,
        acmeEmail: this.settings.acmeEmail,
      };
      if (this.settings.password) payload.dashboardPassword = this.settings.password;
      if (this.settings.dashboardBindAddress) {
        payload.dashboardBindAddress = this.settings.dashboardBindAddress;
      }
      if (this.settings.dashboardAuth) payload.dashboardAuth = this.settings.dashboardAuth;
      const r = await this.api('POST', '/api/settings', payload);
      this.settings.loading = false;
      if (r.ok) {
        // The port and the bind address only apply on restart; saying "saved"
        // alone would imply the change is already in force.
        this.settings.msg = r.data.needsRestart
          ? 'Settings saved ✓ — restart the dashboard for the port and bind address to take effect'
          : 'Settings saved ✓';
        this.settings.password = '';
        await this.loadSettings();
      } else { this.settings.error = r.data.error || 'Save failed'; }
    },

    openAddChannel() {
      this.channelModal.editing = null;
      this.channelModal.form = { name: '', type: 'discord', webhookUrl: '', botToken: '', chatId: '', message: '' };
      this.channelModal.error = '';
      this.channelModal.open = true;
    },

    openEditChannel(channel) {
      this.channelModal.editing = channel.id;
      this.channelModal.form = {
        name: channel.name,
        type: channel.type,
        webhookUrl: channel.webhookUrl || '',
        botToken: channel.botToken || '',
        chatId: channel.chatId || '',
			message: channel.message || '',
      };
      this.channelModal.error = '';
      this.channelModal.open = true;
    },

    async saveChannel() {
      this.channelModal.saving = true;
      this.channelModal.error = '';
      const { name, type, webhookUrl, botToken, chatId, message } = this.channelModal.form;
      const payload = { name, type, webhookUrl, botToken, chatId, message };
      const r = this.channelModal.editing
        ? await this.api('PUT', `/api/settings/channels/${this.channelModal.editing}`, payload)
        : await this.api('POST', '/api/settings/channels', payload);
      this.channelModal.saving = false;
      if (r.ok) {
        this.channelModal.open = false;
        await this.loadChannels();
      } else {
        this.channelModal.error = r.data.error || 'Save failed';
      }
    },

    async deleteChannel(id) {
      const { isConfirmed } = await Swal.fire({
        title: 'Delete channel?',
        text: 'This cannot be undone.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Delete',
        cancelButtonText: 'Cancel',
        ...this.swalTheme,
      });
      if (!isConfirmed) return;
      await this.api('DELETE', `/api/settings/channels/${id}`);
      await this.loadChannels();
    },

    async testChannelById(id) {
      this.channels.testingId = id;
      this.channels.testResults = { ...this.channels.testResults, [id]: { msg: '', error: '' } };
      const r = await this.api('POST', `/api/settings/channels/${id}/test`);
      this.channels.testingId = null;
      this.channels.testResults = {
        ...this.channels.testResults,
        [id]: r.ok
          ? { msg: 'Test sent ✓', error: '' }
          : { msg: '', error: r.data.error || 'Test failed' },
      };
    },
  },
})
.directive('click-outside', {
  mounted(el, binding) {
    el._clickOutside = (e) => { if (!el.contains(e.target)) binding.value(e); };
    document.addEventListener('mousedown', el._clickOutside);
  },
  unmounted(el) {
    document.removeEventListener('mousedown', el._clickOutside);
  },
})
.mount('#app');
