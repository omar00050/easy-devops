/* global Vue, io */
const { createApp } = Vue;

// Default form structure matching DOMAIN_DEFAULTS
const DEFAULT_FORM = {
  name: '',
  port: 3000,
  backendHost: '127.0.0.1',
  upstreamType: 'http',
  www: false,
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
};

createApp({
  data() {
    return {
      theme: localStorage.getItem('ed-theme') || 'dark',
      authenticated: false,
      page: 'overview',

      login: { password: '', error: '', loading: false },

      navItems: [
        { id: 'overview', label: 'Overview', icon: '⚡' },
        { id: 'nginx', label: 'Nginx', icon: '🌐' },
        { id: 'ssl', label: 'SSL Certs', icon: '🔒' },
        { id: 'domains', label: 'Domains', icon: '🔗' },
        { id: 'settings', label: 'Settings', icon: '⚙️' },
      ],

      nginx: {
        status: null, loading: false,
        actionMsg: '', actionError: '',
        configs: [], selectedConfig: '',
        configContent: '', configSaving: false, configMsg: '',
        logs: [], logsLoading: false,
      },

      ssl: {
        certs: [], loading: false, error: '', renewingDomain: null,
        showCreateForm: false,
        createDomain: '', createWww: false,
        creating: false, createResult: null, createError: null,
      },

      // T017-T019: Updated domains state
      domains: {
        list: [], loading: false, error: '',
        showForm: false,
        editingName: null, // T017: null = adding, string = editing
        saving: false,
        dirty: false, // T019: Track unsaved changes
        form: JSON.parse(JSON.stringify(DEFAULT_FORM)), // T025: Nested v2 structure
        certMissing: null,   // { certPath, keyPath, hint } set when POST /api/domains returns 422
        certCreating: false, // true while POST /api/ssl/create is in-flight
        certCreateError: null, // structured error from a failed cert creation
      },

      // T018: Collapsible section state
      sections: {
        basic: true,
        ssl: true,
        performance: false,
        security: false,
        advanced: false,
      },

      settings: {
        dashboardPort: '', nginxDir: '', certbotDir: '',
        password: '', loading: false, msg: '', error: '',
        platform: 'linux', // T022: Platform from settings API
      },
    };
  },

  computed: {
    isDark() { return this.theme === 'dark'; },
    expiringCount() { return this.ssl.certs.filter(c => c.daysLeft !== null && c.daysLeft < 30).length; },
  },

  watch: {
    theme(val) {
      localStorage.setItem('ed-theme', val);
      document.documentElement.classList.toggle('dark', val === 'dark');
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

    // Check if already authenticated
    try {
      const r = await fetch('/api/auth');
      const d = await r.json();
      if (d.authenticated) { this.authenticated = true; this.loadPage('overview'); }
    } catch { /* server may not be up yet */ }

    // T022: Load settings to get platform for SSL path auto-population
    await this.loadSettings();

    // Real-time nginx status via Socket.io
    const socket = io();
    socket.on('nginx:status', (status) => {
      this.nginx.status = status;
    });
  },

  methods: {
    // ── Core API helper ────────────────────────────────────────────────────────
    async api(method, path, body) {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const r = await fetch(path, opts);
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    },

    // ── Theme ─────────────────────────────────────────────────────────────────
    toggleTheme() { this.theme = this.theme === 'dark' ? 'light' : 'dark'; },

    // ── Auth ──────────────────────────────────────────────────────────────────
    async doLogin() {
      this.login.loading = true; this.login.error = '';
      const r = await this.api('POST', '/api/login', { password: this.login.password });
      this.login.loading = false;
      if (r.ok) { this.authenticated = true; this.login.password = ''; this.loadPage('overview'); }
      else { this.login.error = r.data.error || 'Invalid password'; }
    },

    async doLogout() {
      await this.api('POST', '/api/logout');
      this.authenticated = false;
    },

    // ── Navigation (T021: Nav click guard) ────────────────────────────────────
    async navigateTo(pageId) {
      // T021: Check for unsaved changes before navigation
      if (this.domains.dirty && this.domains.showForm) {
        if (!confirm('You have unsaved changes. Discard them and continue?')) {
          return;
        }
        this.resetDomainForm();
      }
      await this.loadPage(pageId);
    },

    async loadPage(p) {
      this.page = p;
      if (p === 'overview') {
        await Promise.all([this.loadNginxStatus(), this.loadSSL(), this.loadDomains()]);
      } else if (p === 'nginx') {
        await Promise.all([this.loadNginxStatus(), this.loadNginxConfigs(), this.loadNginxLogs()]);
      } else if (p === 'ssl') { await this.loadSSL(); }
      else if (p === 'domains') { await this.loadDomains(); }
      else if (p === 'settings') { await this.loadSettings(); }
    },

    // ── Collapsible Sections ────────────────────────────────────────────
    toggleSection(sectionId) {
      this.sections[sectionId] = !this.sections[sectionId];
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
      });
      this.ssl.creating = false;
      if (r.ok) {
        this.ssl.createResult = r.data;
        this.ssl.createDomain = '';
        this.ssl.createWww = false;
        await this.loadSSL();
      } else if (r.status === 503) {
        this.ssl.createError = { step: 'ACME client detection', cause: r.data.hint, consequence: 'Install certbot or win-acme first using the SSL Manager CLI.', nginxRunning: true };
      } else if (r.status === 409) {
        this.ssl.createError = { step: 'port 80 check', cause: r.data.detail, consequence: r.data.hint, nginxRunning: true };
      } else {
        this.ssl.createError = r.data.error || { step: 'certificate issuance', cause: 'Unknown error', consequence: 'No certificate was issued.' };
      }
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

    // ── Domains ───────────────────────────────────────────────────────────────
    async loadDomains() {
      this.domains.loading = true;
      const r = await this.api('GET', '/api/domains');
      this.domains.loading = false;
      if (r.ok) this.domains.list = r.data;
    },

    toggleDomainForm() {
      if (this.domains.showForm && this.domains.dirty) {
        if (!confirm('Discard unsaved changes?')) return;
      }
      this.domains.showForm = !this.domains.showForm;
      if (!this.domains.showForm) {
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
      // Reset sections
      this.sections = {
        basic: true,
        ssl: true,
        performance: false,
        security: false,
        advanced: false,
      };
    },

    // T023: editDomain method
    async editDomain(name) {
      // Check for unsaved changes
      if (this.domains.dirty && this.domains.showForm) {
        if (!confirm('Discard unsaved changes?')) return;
      }

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
      const r = await this.api('POST', '/api/ssl/create', { domain, www });
      this.domains.certCreating = false;

      if (r.ok) {
        // Update cert paths in the form with what certbot actually wrote
        this.domains.form.ssl.certPath = r.data.certPath;
        this.domains.form.ssl.keyPath = r.data.keyPath;
        this.domains.certMissing = null;
        // Retry the domain save now that the cert exists
        await this.saveDomain();
      } else if (r.status === 503) {
        this.domains.certCreateError = { step: 'ACME client detection', cause: r.data.hint, consequence: 'Install certbot or win-acme first.', nginxRunning: true };
      } else if (r.status === 409) {
        this.domains.certCreateError = { step: 'port 80 check', cause: r.data.detail, consequence: r.data.hint, nginxRunning: true };
      } else {
        this.domains.certCreateError = r.data.error || { step: 'certificate issuance', cause: 'Unknown error', consequence: 'No certificate was issued.' };
      }
    },

    disableSslAndSave() {
      this.domains.form.ssl.enabled = false;
      this.domains.certMissing = null;
      this.domains.certCreateError = null;
      this.saveDomain();
    },

    dismissCertMissing() {
      this.domains.certMissing = null;
      this.domains.certCreateError = null;
    },

    async deleteDomain(name) {
      if (!confirm(`Delete domain "${name}"? This cannot be undone.`)) return;
      await this.api('DELETE', `/api/domains/${name}`);
      await this.loadDomains();
    },

    async reloadDomain(name) {
      await this.api('POST', `/api/domains/${name}/reload`);
    },

    // T024: Auto-populate SSL paths when SSL is enabled
    autoPopulateCertPaths() {
      if (this.domains.form.ssl.enabled) {
        if (!this.domains.form.ssl.certPath || !this.domains.form.ssl.keyPath) {
          const domain = this.domains.form.name;
          if (domain) {
            const platform = this.settings.platform;
            if (platform === 'win32') {
              this.domains.form.ssl.certPath = `C:\\Certbot\\live\\${domain}\\fullchain.pem`;
              this.domains.form.ssl.keyPath = `C:\\Certbot\\live\\${domain}\\privkey.pem`;
            } else {
              this.domains.form.ssl.certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
              this.domains.form.ssl.keyPath = `/etc/letsencrypt/live/${domain}/privkey.pem`;
            }
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
        this.settings.certbotDir = r.data.certbotDir;
        this.settings.platform = r.data.platform || 'linux'; // T022
      }
    },

    async saveSettings() {
      this.settings.loading = true; this.settings.msg = ''; this.settings.error = '';
      const payload = {
        dashboardPort: this.settings.dashboardPort,
        nginxDir: this.settings.nginxDir,
        certbotDir: this.settings.certbotDir,
      };
      if (this.settings.password) payload.dashboardPassword = this.settings.password;
      const r = await this.api('POST', '/api/settings', payload);
      this.settings.loading = false;
      if (r.ok) { this.settings.msg = 'Settings saved ✓'; this.settings.password = ''; }
      else { this.settings.error = r.data.error || 'Save failed'; }
    },
  },
}).mount('#app');
