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
};

createApp({
  data() {
    return {
      theme: localStorage.getItem('ed-theme') || 'dark',
      accent: localStorage.getItem('ed-accent') || 'teal',
      sidebarCollapsed: localStorage.getItem('ed-sidebar') === 'true',
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
      },

      settings: {
        dashboardPort: '', nginxDir: '', sslDir: '', acmeEmail: '',
        password: '', loading: false, msg: '', error: '',
        platform: 'linux', // T022: Platform from settings API
      },

      permissions: {
        configured: false, loading: false, password: '', msg: '', error: '',
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
    setAccent(color) { this.accent = color; },

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
      this.page = p;
      if (p === 'overview') {
        await Promise.all([this.loadNginxStatus(), this.loadSSL(), this.loadDomains()]);
      } else if (p === 'nginx') {
        await Promise.all([this.loadNginxStatus(), this.loadNginxConfigs(), this.loadNginxLogs()]);
      } else if (p === 'ssl') { await this.loadSSL(); }
      else if (p === 'domains') { await this.loadDomains(); }
      else if (p === 'settings') { await Promise.all([this.loadSettings(), this.loadPermissionsStatus()]); }
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
            if (platform === 'win32') {
              this.domains.form.ssl.certPath = `C:\\easy-devops\\ssl\\${domain}\\fullchain.pem`;
              this.domains.form.ssl.keyPath = `C:\\easy-devops\\ssl\\${domain}\\privkey.pem`;
            } else {
              this.domains.form.ssl.certPath = `/etc/easy-devops/ssl/${domain}/fullchain.pem`;
              this.domains.form.ssl.keyPath = `/etc/easy-devops/ssl/${domain}/privkey.pem`;
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
        this.settings.sslDir = r.data.sslDir;
        this.settings.acmeEmail = r.data.acmeEmail || '';
        this.settings.platform = r.data.platform || 'linux'; // T022
      }
    },

    async loadPermissionsStatus() {
      if (this.settings.platform === 'win32') { this.permissions.configured = true; return; }
      const r = await this.api('GET', '/api/settings/permissions');
      if (r.ok) this.permissions.configured = r.data.configured;
    },

    async setupPermissions() {
      this.permissions.loading = true; this.permissions.msg = ''; this.permissions.error = '';
      const r = await this.api('POST', '/api/settings/permissions/setup', { password: this.permissions.password });
      this.permissions.loading = false;
      if (r.ok) {
        this.permissions.configured = true;
        this.permissions.msg = 'Permissions configured ✓';
        this.permissions.password = '';
      } else {
        this.permissions.error = r.data?.error || 'Setup failed';
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
      const r = await this.api('POST', '/api/settings', payload);
      this.settings.loading = false;
      if (r.ok) { this.settings.msg = 'Settings saved ✓'; this.settings.password = ''; }
      else { this.settings.error = r.data.error || 'Save failed'; }
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
