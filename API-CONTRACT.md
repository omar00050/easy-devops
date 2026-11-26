# Easy DevOps — Dashboard API Contract

**Contract version: 2.18.0** · Last updated: 2026-11-24 · Derived from the code in
`src/dashboard/`, not from any earlier plan.

> ## The rule
>
> **Any change to an endpoint or a Socket.io event updates this file first, in
> the same change.** Adding, removing or renaming a route, changing a request or
> response shape, or changing which auth applies — all of it lands here before
> or alongside the code.
>
> This is enforced, not merely requested: `e2e/run.mjs` compares the routes
> actually registered by `src/dashboard/routes/*.js` against the table below and
> **fails the test run on any mismatch**. `npm test` will not pass if they
> disagree.
>
> The contract version is semantic: MAJOR for a removal or an incompatible
> change to an existing endpoint or event, MINOR for additions, PATCH for
> documentation-only corrections.

---

## 1. Transport and request rules

All REST endpoints are under `/api`. All requests and responses are JSON
(`Content-Type: application/json`), except `GET /api/settings/backup`, which
sends a file download.

Three checks apply to **every** `/api` request, before authentication, and in
**both** auth modes. They are implemented in `src/dashboard/lib/localRequest.js`
and they defend against a hostile page in the same browser — something a
password never protected against.

| Check | Rule | Failure |
|---|---|---|
| `Host` | Port must match the dashboard's. A direct request must use `localhost`, `127.0.0.1` or `[::1]`. | `403` |
| `Origin` | When present: protocol and port must match the direct HTTP request, and its hostname must be a loopback name. | `403` |
| `X-EZ-Request: 1` | Required on every `POST`, `PUT`, `PATCH`, `DELETE`, and on the Socket.io handshake. Not required on `GET`. | `403` |

The dashboard always listens on a loopback address because its listener uses
plain HTTP. For remote access, an HTTPS reverse proxy or authenticated tunnel on
the same machine connects to that listener. A request is treated as a trusted
proxy request only when its TCP peer is loopback, `X-Forwarded-Proto` is exactly
`https`, and one `X-Forwarded-Host` value is present. The public forwarded host
then replaces the direct `Host` and the `Origin` must use `https` and the
effective HTTPS port. Duplicate `Host`, `X-Forwarded-Host` or
`X-Forwarded-Proto` headers are refused. Sessions on this path use a `Secure`
cookie.

A `403` from these checks carries `{ error, reason, detail }`, where `reason` is
one of `host_missing`, `host_port_mismatch`, `host_not_local`,
`host_invalid`, `duplicate_forwarding_header`, `origin_malformed`,
`origin_protocol_mismatch`, `origin_port_mismatch`, `origin_not_local`,
`origin_cross_site`, `missing_request_header`.

**403 is deliberately not 401.** A login cannot fix "this request may not be
made from where it came from", so the client must not be sent to the login
screen.

### Authentication

`dashboardAuth` is either `password` (default) or `none`.

- **`password`** — every endpoint marked *session* requires a logged-in session
  cookie. Without one: `401 { error: "Unauthorized" }`.
- **`none`** — no session is required only for a direct request whose TCP peer
  is loopback and which carries no forwarding headers. A request through a
  local HTTPS proxy or tunnel therefore requires a session even when the stored
  setting is `none`. If the stored config ever says `none` with a non-loopback
  bind, the bind is repaired to loopback and a password is required anyway
  (`effectiveAuthMode()` in `src/core/config.js`).

The transport checks above are **not** relaxed in `none` mode. In that mode they
are the only defence left, which is what makes "no password on loopback" a
defensible option rather than an open door.

**Auth column values used below:** `public` (no session needed, ever) ·
`session` (session required in `password` mode).

---

## 2. REST endpoints

### 2.1 Authentication — `src/dashboard/routes/auth.js`

The only public router. Everything here exists so a client can obtain a session
in the first place, so it cannot sit behind the session gate; each endpoint
carries its own guard instead.

| Method | Path | Auth |
|---|---|---|
| GET | `/api/auth` | public |
| POST | `/api/login` | public |
| POST | `/api/setup` | public |
| POST | `/api/logout` | public |

**`GET /api/auth`** — what the page needs to decide between the dashboard, the
login form and the first-run screen.

Response `200`:
```json
{
  "authenticated": true,
  "needsSetup": false,
  "authMode": "password",
  "canUseNoPassword": false,
  "bindAddress": "127.0.0.1",
  "minPasswordLength": 6,
  "setupCodeRequired": false,
  "setupCodeExpiresAt": null
}
```
`canUseNoPassword` is true only when the bind is loopback **and** this request
is a direct loopback request with no proxy headers. It drives whether the
first-run screen offers the "No password" option at all.

`setupCodeRequired` is true while first-run setup is pending and a one-time
setup code is outstanding; the first-run screen must then collect it alongside
the new password. `setupCodeExpiresAt` is an epoch-millisecond timestamp, or
`null` when no code is outstanding — it lets the screen say the code has
expired instead of only reporting a rejection.

**The code itself is never in any response.** It is printed to the local
terminal and written to the local service log, and nowhere else: not here, not
in a Socket.io event, and not in anything the Hub agent sends. A client learns
only *whether* a code is required, never what it is.

**`POST /api/login`** — `{ "password": "…" }`

- `200` `{ "ok": true }` — a session cookie is issued, and the session id is
  regenerated to prevent fixation.
- `401` `{ "ok": false, "error": "Invalid password" }`
- `401` `{ "ok": false, "error": "…", "needsSetup": true }` — no password is set.
- `409` `{ "ok": false, "error": "…", "authMode": "none" }` — nothing to log into.
- `429` `{ "ok": false, "error": "…", "retryAfterSeconds": 900 }` plus a
  `Retry-After` header. Rate limit: 10 attempts per 15 minutes per IP.

**`POST /api/setup`** — first run only. Either:
```json
{ "password": "at least 6 characters", "setupCode": "418 902" }
```
or
```json
{ "mode": "none" }
```

`setupCode` is **required whenever `setupCodeRequired` is true** and a password
is being set. It is the first-run takeover protection: this endpoint is public
by necessity — there is no session to require before the first password exists —
so without a code whoever reaches a freshly started dashboard first owns it.
Six digits, accepted with or without the space, valid for 24 hours.

`mode: "none"` does **not** require the code: it is already restricted to a
loopback bind **and** a loopback request, which is a stronger constraint than
the code provides. It still **clears** any outstanding code, exactly as setting
a password does: setup is finished on that path too, and a credential nobody
needs is one more thing that can be read.

- `200` `{ "ok": true, "authMode": "password" | "none" }` — signs the user in
  when a password was set. The code is invalidated at this point and a later
  attempt to reuse it fails.
- `400` `{ "ok": false, "error": "…" }` — password too short, `mode: "none"`
  requested where it is not permitted, or the setup code is missing, wrong or
  expired. A wrong code is not distinguished from a missing one in the message.
- `409` `{ "ok": false, "error": "…" }` — already configured. Prevents this
  public endpoint being used to take over an installation.
- `429` `{ "ok": false, "error": "…", "retryAfterSeconds": 900 }` plus a
  `Retry-After` header — too many setup attempts from this IP. Counted in its
  own budget, so setup guesses cannot exhaust the login budget or the reverse.
- `500` `{ "ok": false, "error": "…" }`

**After 20 failed code attempts in total**, across every IP, the outstanding
code is invalidated: `setupCodeRequired` stays true, every `setupCode` is then
rejected, and the service log says why. A new code can only be issued from the
machine itself:

```
ezz dashboard setup-code
```

That cap is what makes six digits defensible. A per-IP limit alone is
bypassable from many addresses; a global cap bounds the whole attack to 20
guesses against a 10<sup>6</sup> space, and the only way back is physical or
shell access to the server.

**`POST /api/logout`** — no body. `200 { "ok": true }`. Destroys the session.

### 2.2 Domains — `src/dashboard/routes/domains.js` (mounted at `/api/domains`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/domains` | session | List domains (v2 schema, migrated on read) |
| POST | `/api/domains` | session | Create a domain and write its nginx config |
| PUT | `/api/domains/:name` | session | Update a domain and regenerate its config |
| DELETE | `/api/domains/:name` | session | Delete a domain and its config |
| PUT | `/api/domains/:name/toggle` | session | Enable/disable without deleting |
| POST | `/api/domains/:name/reload` | session | Test and reload nginx for one domain |
| GET | `/api/domains/:name/notifications` | session | Per-domain notification config |
| PUT | `/api/domains/:name/notifications` | session | Replace that config |
| GET | `/api/domains/:name/ssl-suggestion` | session | Existing certificate that could serve this domain |

Create/update bodies carry the v2 domain shape: `name` (create only — it is
immutable and ignored on update), `port`, `backendHost`, `upstreamType`, `www`,
`wildcard`, and the nested `ssl`, `performance`, `security`, `advanced` objects.
On update every field is optional and is deep-merged over the stored domain;
`configFile` is ignored, and a `notifications` object is written to the domain's
notification config rather than into the domain object. Unspecified fields take
`DOMAIN_DEFAULTS` on create.

Typed domain fields reject line breaks, semicolons and braces before nginx
files are written. Use a hostname, IP address or HTTP(S) URL for the upstream,
whole numbers for timeouts and rates, and space-separated MIME types for gzip.
Invalid domain input returns HTTP 400 with an `error` message.
`advanced.customLocations` accepts literal nginx configuration.

`behindCloudflare` (boolean, default `false`) is optional on create/update. When
`true`, the generated server block adds `set_real_ip_from` for every published
Cloudflare IPv4/IPv6 range and `real_ip_header CF-Connecting-IP`. Absent means
`false`, so domains stored before this field keep their existing output. A
non-boolean value is `400 Invalid behindCloudflare: must be true or false`.

Responses: `201` (create) or `200` (update) with the stored domain object plus
its current `notifications` map; `{ "enabled": boolean }` for toggle; and the
delete response below. `PUT /api/domains/:name/toggle` takes **no body**: it
flips the domain's current state, so two clients cannot disagree about the
target.

`DELETE /api/domains/:name` always removes the domain record and its nginx
config. Without `?deleteCert=true`, or for a domain without SSL enabled, it
answers:

```json
{ "deleted": "example.com", "certDeleted": false }
```

With `?deleteCert=true`, it also asks the shared certificate lifecycle service
to remove the certificate. A successful certificate removal answers
`{ "deleted": name, "certDeleted": true }`. The domain deletion still succeeds
when the certificate cannot safely be removed. In that case the response keeps
the certificate and reports why:

```json
{
  "deleted": "example.com",
  "certDeleted": false,
  "certRetained": true,
  "certReason": "cert_in_use",
  "certMessage": "The domain was deleted, but its certificate is still used by another domain or nginx configuration and was retained.",
  "usedBy": ["another.example.com"],
  "references": [{ "file": "another.example.com.conf", "line": 8 }]
}
```

`certReason` is `cert_in_use`, `cert_not_managed`, or `delete_failed`.
`usedBy` is empty unless another stored domain uses the certificate.
`references` contains configuration file basenames and one-based line numbers,
never full paths or configuration text. An unmanaged certificate is retained
because it is not recorded as Easy DevOps-owned.

Errors: `400` validation (including a toggle of a domain whose config file path
was never recorded) · `404` `{ "error": "Domain not found: …" }` ·
`409` `{ "error": "Domain already exists: <name>" }` when `POST` names a domain
that is already stored — the check runs before anything is written, so the
existing config is never overwritten ·
`422` `{ "error": "cert_missing", "certPath", "keyPath", "hint" }` when SSL is
on but the certificate files are absent · `500` with
`{ "error", "details"|"output" }` when nginx rejects the generated config (the
previous config is restored first).

An item from `GET /api/domains` may also carry `sslPathWarning: true` when its
stored certificate paths contain backslashes — nginx on Windows can fail to
load a config with those. The remedy is to open and save the domain, which
regenerates the paths with forward slashes. The field name is kept as the
backend produces it rather than renamed for the API, since the dashboard UI is
its only consumer and renaming would break that for no gain.

`GET`/`PUT /api/domains/:name/notifications` exchange a map keyed by
`nginx_down` | `cert_expiry` | `domain_health`, each value
`{ "enabled": boolean, "channelIds": ["…"] }`.

`GET /api/domains/:name/ssl-suggestion` is read-only and answers
`{ "found": false }` or:

```json
{
  "found": true,
  "match": "exact | san | wildcard",
  "certificate": {
    "domain": "example.com",
    "names": ["example.com", "www.example.com"],
    "certPath": "/etc/easy-devops/ssl/example.com/fullchain.pem",
    "keyPath": "/etc/easy-devops/ssl/example.com/privkey.pem",
    "expiry": "2027-02-01T00:00:00.000Z",
    "daysLeft": 76,
    "status": "valid"
  }
}
```

`exact` is a certificate directory named after the domain, `san` a name inside
the certificate, `wildcard` a `*.` name covering exactly one label. It changes
nothing; the UI offers the paths and fills them only when the operator accepts.
The name does **not** have to exist as a domain yet: the deployments link dialog
asks before it creates one. An empty name is `400`; a name with no matching
certificate is `200 { "found": false }`.

### 2.3 SSL — `src/dashboard/routes/ssl.js` (mounted at `/api/ssl`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/ssl` | session | List certificates with expiry and status |
| POST | `/api/ssl/create` | session | Issue a certificate |
| POST | `/api/ssl/create-confirm` | session | Continue a DNS-01 issuance after the TXT record is in place |
| POST | `/api/ssl/create-cancel` | session | Abandon a pending DNS-01 issuance |
| POST | `/api/ssl/renew/:domain` | session | Renew one certificate |
| POST | `/api/ssl/renew-all` | session | Renew everything expiring within 30 days |
| DELETE | `/api/ssl/:domain` | session | Delete a certificate, refusing while nginx configs still reference it |

**`GET /api/ssl`** response `200` is an array; each item is:
```json
{ "domain": "example.com", "expiry": "2027-01-02T00:00:00.000Z", "daysLeft": 50, "status": "valid", "label": null }
```
`status` is one of `valid` | `expiring` | `expired` | `not_issued` | `unreadable`:

- `expiring` means fewer than 30 days remain.
- `expired` means `daysLeft` has already passed zero — `daysLeft` is
  **negative** in that case, and clients display it as overdue rather than
  clamping it to zero.
- `not_issued` (2.16.0) means the certificate directory exists but no
  certificate file was ever issued for the domain. `expiry` and `daysLeft` are
  both `null`, and `label` is `"Not issued yet"`.
- `unreadable` (2.16.0) means `fullchain.pem` exists but neither Node nor
  openssl can parse it. `expiry` and `daysLeft` are both `null`, and `label`
  is `null`.
- Otherwise `expiry` is an ISO string and `daysLeft` a number.

The old single `error` status is split into `not_issued` and `unreadable`;
a client that treated `error` as "show a warning, hide the dates" can treat
both new values that way, but should show `Not issued yet` for `not_issued`
rather than an error.

Since 2.3.0 each item also carries what the background job intends for it
(additive — a client may ignore all three):

```json
{
  "autoRenew": "auto",
  "autoRenewDays": 7,
  "lastAutoRenew": { "at": 1794000000000, "result": "failed", "error": "DNS problem: NXDOMAIN" }
}
```

- `autoRenew` is one of `auto` (renewed in the background once `daysLeft` is at
  or below `autoRenewDays`) | `manual` (a DNS-01 certificate — every wildcard
  is one — needs a TXT record added by hand, so it only gets the expiry
  warning) | `unused` (no enabled domain with SSL on serves it, so it is left
  alone) | `off` (`sslAutoRenew` is false).
- `lastAutoRenew` is `null` until the job has attempted this certificate.
  `result` is `renewed` or `failed`; `error` is the one-line reason for a
  failure.

The value is computed by the function the job itself uses
(`autoRenewPlan()` in `core/cert-renewal.js`), so the list cannot promise a
renewal the job will not perform.

`POST /api/ssl/create` takes
`{ domain, www?, validationMethod: "http"|"dns", email?, opId? }`.

`opId` (2.16.0) is optional and is the client's correlation id for live
progress. When present it must match `/^[A-Za-z0-9_-]{8,64}$/`; otherwise the
answer is `400` `{ "error": "invalid_opId", "detail": … }`. When absent the
server generates one. Every response — including the DNS-01 `202`, the final
`200`, and an error — carries the effective value as `opId`.

- HTTP-01: `200` with the issuance result, including `opId`, `mode`,
  `fellBack`, `nginxDownMs` and a human `summary`.
- DNS-01: `202` with the TXT record to create; the request then waits for
  `create-confirm` or `create-cancel`.
- `400` `{ "error": "email_required", "hint": … }` when no ACME email is set.

`POST /api/ssl/renew/:domain` accepts the same optional `opId`, with the same
validation and the same `opId` echoed in every response, including `409
manual_renewal_required` and `500`.

`POST /api/ssl/renew-all` accepts the same optional `opId`. The response stays
an array; each per-domain result additionally carries `opId`, the same value
for every item in that request. Stages for all domains share that opId and are
told apart by the event's `domain`.

`renew-all` returns an array of per-domain results, each with `domain`,
`opId`, `success`, `certPath`, `keyPath`, `mode`, `fellBack`, `nginxDownMs`,
`configRegenerated`, `nginxReloaded`, `preflight`, `summary`.

**The preflight array (2.17.0).** Every `POST /api/ssl/create` and
`POST /api/ssl/renew/:domain` response — success or failure — and every entry of
`renew-all` carries the checks that ran:

```json
"preflight": [
  { "id": "dns:example.com", "status": "ok | warn | fail | skipped", "message": "…", "fix": "…" }
]
```

It is `null` only when the request stopped before preflight ran: a missing ACME
email, a wildcard over HTTP-01, a certificate that needs manual DNS-01 renewal,
or a challenge setup that failed first. Each `renew-all` entry carries its own
array, because each domain is checked separately. `status` is `fail` for a
check that stopped the request, `warn` for a condition the operator should know
about, and `skipped` where the check does not apply (the IPv6 and HTTP checks
under DNS-01).

**Preflight (2.16.0).** Before any Let's Encrypt request — for issue, renew and
each item of renew-all — the server checks DNS, IPv6 reachability, the public
HTTP challenge path and Cloudflare's role. A failed check stops there: no
account, order or failed validation, so no rate limit is spent. The result's
`error` has `step: "preflight"`, the real cause and a one-line `fix`. For
DNS-01 the IPv6/HTTP checks are reported as `skipped` with a reason.

The whole issue or renewal is bounded at **five minutes**; a run that runs out
of time fails with `step` naming the stage it was in rather than leaving the
request open. Each stage is reported as it happens — see §3.1 and §3.5.

**`DELETE /api/ssl/:domain`** removes only files recorded for that certificate
in the Easy DevOps managed-artifact manifest, then removes the now-empty
directory. It never recursively removes `${sslDir}/${domain}`. Files that
Easy DevOps did not record, later replacements whose identity no longer
matches the manifest, and unrelated files are kept. Before deleting anything
it scans the nginx configuration tree (`nginxDir`, recursively, over `*.conf`
and `*.conf.disabled` files including the main `nginx.conf`) for lines that
point into that directory.

- `200` `{ "deleted": "broken.example.com", "directory": "/etc/easy-devops/ssl/broken.example.com" }`.
- `404` `{ "error": "Certificate '<domain>' not found" }` when the certificate
  directory does not exist. The name is looked up among the direct children of
  `sslDir` (unreadable and not-yet-issued directories included), never joined
  from the URL, so a traversal name is simply not found (1.4.2).
- `409` when a config still references the certificate; nothing is deleted:
  ```json
  {
    "error": "cert_in_use",
    "directory": "/etc/easy-devops/ssl/app.example.com",
    "usedBy": ["app.example.com"],
    "references": [
      {
        "file": "/etc/nginx/conf.d/app.example.com.conf",
        "line": 14,
        "text": "ssl_certificate /etc/easy-devops/ssl/app.example.com/fullchain.pem;"
      }
    ],
    "hint": "At least one nginx config still points at this certificate. …"
  }
  ```
  Disable SSL on the referencing domain (or remove the lines) first; this is
  what keeps a delete from leaving nginx pointing at missing files. `usedBy`
  (1.4.2) lists the enabled domains with SSL on whose certificate lives in that
  directory; either a non-empty `usedBy` or any reference refuses the delete.
  The Hub agent deletes through the same check (`core/cert-usage.js`).
- `409` `{ "error": "cert_not_managed", "detail": "…" }` when the certificate
  has no matching managed-artifact ownership record, or has no files recorded
  for it. Nothing is deleted.
- `500` `{ "error": "delete_failed", "detail": "…" }` when a recorded file no
  longer matches its ownership identity, a path is linked or unsafe, or the
  filesystem refuses the operation. Remaining unrelated content is kept.

**Renewal behaviour (2.3.0).** `renew/:domain`, `renew-all`, the CLI, the Hub
command and the background job all go through `renewCertificate()` in
`core/cert-renewal.js`:

- The renewed certificate covers the **same names** as the one it replaces,
  read back from the certificate. A certificate issued with `www` keeps `www`;
  before 2.3.0 a renewal silently dropped it.
- After a proxy-mode renewal nginx is **reloaded**, and the result carries
  `nginxReloaded: true | false` (`null` in standalone mode, which restarts
  nginx itself). `false` means the new certificate is on disk but nginx is
  still serving the old one — `summary` says so.
- A DNS-01 / wildcard certificate is refused rather than replaced by a
  single-name HTTP-01 certificate: `renew/:domain` answers `409`
  `{ "error": "manual_renewal_required", "detail": …, "hint": … }`, and
  `renew-all` reports that item with `success: false`,
  `error: "manual_renewal_required"`.

### 2.4 Nginx — `src/dashboard/routes/nginx.js` (mounted at `/api/nginx`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/nginx/status` | session | `{ running, version, pid }` |
| POST | `/api/nginx/start` | session | Start nginx |
| POST | `/api/nginx/stop` | session | Stop nginx |
| POST | `/api/nginx/restart` | session | Restart nginx |
| POST | `/api/nginx/reload` | session | Graceful reload |
| POST | `/api/nginx/test` | session | `nginx -t`, judged by `isNginxTestOk()` |
| GET | `/api/nginx/configs` | session | List config filenames |
| GET | `/api/nginx/config/:filename` | session | `{ content }` |
| POST | `/api/nginx/config/:filename` | session | `{ content }` — written, tested, rolled back on failure |
| GET | `/api/nginx/logs` | session | Recent access/error lines |

**`GET /api/nginx/logs`** takes two optional query parameters and returns
`{ lines: string[], file: "error" | "access" }`:

| Parameter | Values | Default |
|---|---|---|
| `file` | `error` \| `access` | `error` |
| `lines` | 1–5000, clamped | `100` |

Both are additive — the endpoint previously took none and always returned 100
lines of the error log, which is still what it does with no parameters. The
access log was unreachable before this, despite the table above having always
described the endpoint as access/error. `file` is echoed back so a client
cannot mistake which log it is displaying.

The log path is resolved by `nginxLogPath()` in `core/platform.js`:
`<nginxDir>/logs/<file>.log` on Windows, `/var/log/nginx/<file>.log`
elsewhere. Reading `<nginxDir>/logs` unconditionally is why this endpoint
returned nothing at all on Linux before.

Service actions return `{ success, output }`. On Linux a failure caused by
missing sudoers rules returns a message naming
`Settings → Setup Linux Permissions` rather than the raw error.

The `version` field in `GET /api/nginx/status` and in the `nginx:status` socket
event (§3.1) already carries the `nginx/` prefix (e.g. `"nginx/1.26.2"`).
Clients must render it as-is and must not add their own prefix.

### 2.5 Settings — `src/dashboard/routes/settings.js` (mounted at `/api`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/settings` | session | Current settings (never the password or its hash) |
| POST | `/api/settings` | session | Update settings |
| GET | `/api/settings/permissions` | session | Linux sudoers state `{ configured }` |
| POST | `/api/settings/permissions/setup` | session | Status + the terminal commands that install `/etc/sudoers.d/easy-devops` (accepts no password) |
| GET | `/api/settings/backup` | session | Download config + domains as JSON |
| POST | `/api/settings/restore` | session | Restore from such a file |
| GET | `/api/settings/channels` | session | Notification channels |
| POST | `/api/settings/channels` | session | Create a channel |
| PUT | `/api/settings/channels/:id` | session | Update a channel |
| DELETE | `/api/settings/channels/:id` | session | Delete a channel |
| POST | `/api/settings/channels/:id/test` | session | Send a test notification |

**`GET /api/settings`** response `200`:
```json
{
  "dashboardPort": 6443,
  "nginxDir": "/etc/nginx",
  "sslDir": "/etc/easy-devops/ssl",
  "acmeEmail": "you@example.com",
  "sslAutoRenew": true,
  "sslAutoRenewDays": 7,
  "sslAutoRenewDaysMin": 1,
  "sslAutoRenewDaysMax": 30,
  "deployDir": "/home/me/.config/easy-devops/ez_deploys",
  "deployDirDefault": "/home/me/.config/easy-devops/ez_deploys",
  "deployDirIsDefault": true,
  "dashboardBindAddress": "127.0.0.1",
  "bindsToLoopbackOnly": true,
  "dashboardAuth": "password",
  "dashboardUi": "new",
  "canUseNoPassword": true,
  "hasPassword": true,
  "platform": "linux"
}
```
Neither `dashboardPassword` nor `dashboardPasswordHash` is ever returned.

**`POST /api/settings`** accepts any subset of `dashboardPort`,
`dashboardPassword`, `dashboardAuth`, `dashboardBindAddress`, `dashboardUi`,
`nginxDir`, `sslDir`, `acmeEmail`, `deployDir`, `sslAutoRenew` (boolean), `sslAutoRenewDays`
(whole number, `sslAutoRenewDaysMin`–`sslAutoRenewDaysMax`; anything else is a
`400`). Response `200`:
`{ "success": true, "needsRestart": boolean, "dashboardAuth": "…", "dashboardUi": "new" | "classic" }`.
`needsRestart` is true when the port, bind address or UI choice changed —
none of them takes effect until the dashboard restarts.

`deployDir` (2.6.0) is the folder **new** deployed apps are created in. Send
an absolute path, or `""` / `null` to go back to the default
(`deployDirDefault`). The folder is created if it does not exist; `400` when it
cannot be, or when the path contains characters a shell would act on. Existing
apps are not moved — see §2.8.

`sslAutoRenew` / `sslAutoRenewDays` (2.3.0) control the background renewal of
HTTP-01 certificates and need no restart: the job reads them on each pass
(every 12 hours, and once when the background service starts). A fresh install
and an install that predates the setting both read as `true` / `7`. The limits
are published so no client hard-codes them.

`dashboardUi` is `new` (the default — the built React app in `dist/ui`) or
`classic` (the old EJS page). Any other value is `400` `{ error }`; an
unrecognised stored value is read as `classic` rather than guessed at, while a
config that never stored the key falls back to the default, `new`. `GET` and
`POST` resolve it through the same helper so they can never report different
values for one config. The setting exists so a background service can select the UI on each
boot; `--classic-ui` overrides it for a single run. See §4.

An install created before the React UI became the default has `classic` written
down through no choice of its own, so a stored `classic` is migrated to `new`
**once**, recorded by `dashboardUiMigrated`; a `classic` chosen deliberately
after that is never overridden.

The **auth/bind interlock** is validated against the state the request would
produce, not the current state:

- Any bind other than `127.0.0.1` or `::1` → `400`
  `{ reason: "dashboard_requires_loopback" }`. Remote use is provided by a
  local HTTPS reverse proxy or secure tunnel.
- Turning auth off from a non-loopback request → `403`
  `{ reason: "no_auth_requires_local_request" }`.
- Setting a password implies `dashboardAuth: "password"`.

**`GET /api/settings/permissions`** returns `200 { "configured": boolean }`
(always `true` on Windows, where sudo is not a concept).

**`POST /api/settings/permissions/setup`** changes nothing and installs nothing:
the dashboard never receives, stores or forwards a sudo password. It takes **no
request body** — a `password` field from an older client is ignored, never read
— and answers `200`:
```json
{
  "configured": false,
  "commands": ["t=\"$(mktemp)\" && printf … && sudo visudo -cf \"$t\" …"],
  "refusedDirs": [{ "dir": "/srv", "reason": "not an absolute, plain Linux path …" }]
}
```
`configured` is exactly what `GET` reports. `commands` are the complete lines
the operator pastes into their own terminal, where sudo asks **them** for the
password; they are the only way the rules are installed. `refusedDirs` lists
directories the setup would have to own but will not hand over (an unsafe
path), with the reason — each one still needs root by hand.

`400` carries the same `configured` and `refusedDirs` plus `error` and an empty
`commands`, and means the script could not be built safely at all (an account
name or directory that cannot be written into a sudoers line); `500 { error }`
is an unexpected failure. On Windows the endpoint is `400 { error }`.

The rules themselves are not described here: `core/permissions.js` is their only
source, and it grants exactly five commands — `systemctl start|stop|reload|
restart|status nginx` — with no wildcards, no shell, no file writer and no
unattended unit management.

**`GET /api/settings/channels`** response `200` is an array; each item is:
```json
{ "id": "…", "name": "…", "type": "discord" | "telegram", "webhookUrl": "…", "botToken": "…", "chatId": "…", "message": "…" }
```
`webhookUrl` applies to `discord`; `botToken` and `chatId` apply to `telegram`;
`message` is optional on either. Only the fields relevant to `type` are present.

`POST /api/settings/channels` takes `{ name, type, webhookUrl?, botToken?,
chatId?, message? }` → `201` with the created item (including its `id`); `400`
with `{ error }` when `name` or `type` is missing, `type` is not `discord` or
`telegram`, or the credentials that type requires are absent. `PUT
/api/settings/channels/:id` takes any subset of `name`, `webhookUrl`,
`botToken`, `chatId` and `message` → `200` with the updated item; `type` is
immutable, a credential for the other type is ignored, `404` for an unknown id
and `400` for an empty name. `POST /api/settings/channels/:id/test` sends one
test message → `200 { success: true }`, `404`, or `500 { error }` when delivery
failed. `DELETE` → `200 { "deleted": id }` or `404`.

`GET /api/settings/backup` strips **both** the password and its hash: a backup is
a file people share, and a scrypt hash is still worth cracking offline.
`POST /api/settings/restore` ignores any `dashboardPassword`,
`dashboardPasswordHash`, `dashboardBindAddress` or `dashboardAuth` in the file,
so a backup can neither reinstate a plain-text password nor silently re-open the
listener.

#### Updating Easy DevOps — `src/dashboard/routes/update.js` (mounted at `/api`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/update` | session | Registry check, install source, and the last run |
| GET | `/api/update/status` | session | The run record alone; no registry call |
| POST | `/api/update` | session | Accept an update run; the worker does the work |

**`GET /api/update`** response `200`:
```json
{
  "current": "1.3.4",
  "latest": "1.3.5",
  "reachable": true,
  "updateAvailable": true,
  "source": {
    "kind": "npm",
    "reason": "an npm-installed package at /usr/lib/node_modules/easy-devops",
    "npmUpdatable": true,
    "howToUpdate": []
  },
  "elevation": { "required": false, "command": null, "shell": null },
  "run": null
}
```
`elevation.required` is `true` on a Windows Server-mode install when this
dashboard process is not elevated: the update replaces the service's runtime
copy, which only administrators may change, so the worker would refuse at its
first check. `command` is then `"ezz update"` and `shell` is
`"Administrator PowerShell"`; the UI shows them instead of an Update button.
`source.kind` is `npm`, `clone` or `unknown`. Only `npm` is updatable in place;
for the others `howToUpdate` carries the commands to run instead, and `POST`
refuses (the same rule as `ezz update` — see `src/core/installSource.js`).
`run` is the last run record (§ below) or `null`. `500 { error }` is an
unexpected failure.

**`GET /api/update/status`** response `200`:
```json
{ "current": "1.3.4", "run": { "…": "the run record" } }
```
It touches no network and no registry, which is why it is the one endpoint a
client polls while the dashboard is going down and coming back. `run` is `null`
until an update has been started from this data directory.

**`POST /api/update`** body `{ "version": "1.3.5" }` — all of it optional and
the body may be absent. `version` accepts a release triple with an optional prerelease suffix
(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`); an omitted version triggers a fresh registry check and uses `latest`.
A malformed version returns `400` before a worker starts. The request never performs the update itself
— npm replaces the files this process runs from, and the process is stopped
mid-way — so it records the run and spawns a detached worker
(`src/dashboard/updateWorker.js`) that survives the restart and performs the
SAME `core/updater.js` flow as `ezz update`.

- `202` `{ "started": true, "run": { … } }` — the worker was started. This is
  NOT "the update succeeded"; the outcome is only ever in the run record.
- `409` when this copy is not npm-managed (`error` and `source` included), when
  a run is already active (`error` and `run` included), or when the registry
  says it is up to date (`error`, `current`, `latest`).
- `403` `{ "error": "elevation_required", "message", "command", "shell" }`
  when `elevation.required` would be `true` (checked before anything else is
  recorded or started).
- `502` `{ "error" }` when the registry cannot be reached and no version was
  given.
- `500` `{ "error": "Internal server error" }` on an unexpected failure.

The dashboard stops within a second or two of the `202`, so clients MUST expect
the next requests to fail with a connection error and keep polling
`GET /api/update/status` until it answers again. The dashboard is restarted on
the port the request actually arrived on (recorded as `dashboard.port`), with
the same data directory.

**The run record** (`run` in both GET responses):
```json
{
  "id": "m9x2k1-a1b2c3",
  "phase": "done",
  "from": "1.3.4",
  "to": "1.3.5",
  "step": null,
  "reason": null,
  "logTail": ["Updating Easy DevOps v1.3.4 -> v1.3.5", "…"],
  "startedAt": 1730000000000,
  "updatedAt": 1730000000000,
  "finishedAt": 1730000000000,
  "workerPid": 41208,
  "dashboard": { "pid": 39884, "port": 6443 },
  "rolledBack": false,
  "restored": null,
  "runningVersion": "1.3.5",
  "versionConfirmed": true,
  "serviceInstalled": true,
  "refreshedCopy": false,
  "dashboardRestarted": true,
  "dashboardPort": 6443
}
```
`workerPid` is the detached worker's process and `dashboard` records which
dashboard asked and on which port it must come back; both are written when the
run starts, and `dashboardPort` at the end is the port it was actually restarted
on. `logTail` is the last 40 lines the worker echoed.
`phase` is one of `starting`, `stopping`, `updating`, `restarting` (active) or
`done`, `failed`, `interrupted` (final). An active phase whose worker is gone
and whose heartbeat is older than 45 s is reported as `interrupted`, never as
still running — the file lives at `update-status.json` in the data directory
and is written atomically. `failed` carries `step` and `reason`; `rolledBack`
and `restored` say whether the previous version was reinstalled and started.

### 2.6 Hub pairing — `src/dashboard/routes/hub.js` (mounted at `/api/hub`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/hub/connect` | session | Save an `ezops://` connection string and start the agent |
| DELETE | `/api/hub/link` | session | Unlink and stop the agent |
| GET | `/api/hub/status` | session | Link + agent state, the permission catalog, and the active data directory |
| PUT | `/api/hub/permissions` | session | Grant/revoke hub permissions |

`GET /api/hub/status` returns `linked`, `hubUrl`, `serverId`, `permissions`,
`tree`, `comingSoon`, `connected`, `status`, `lastError`, `attempts`,
`agentOwner`, `agentReported`, `dataDir`, `defaultDataDir`, `devDataDir`.
**It never returns the shared secret**, and no endpoint echoes an `ezops://`
string back.

`agentOwner` is `"daemon"` when a background service is running (it holds the
Hub connection and the fields describe ITS agent) and `"dashboard"` when this
process holds the agent itself. `agentReported` is `false` in the daemon case
until that process has reported its state over the event channel: the answer is
then honestly "waiting", never a guessed `connected` or a permanent
`connecting` that looks stuck.

`defaultDataDir` and `devDataDir` answer different questions, and conflating
them was a bug:

| Field | True when | Use |
|---|---|---|
| `defaultDataDir` | `dataDir` is the ordinary location for this platform | A `false` here explains an apparent sync bug: a CLI and a dashboard may be reading two different databases |
| `devDataDir` | this is a **development** run — `--dev`/`EZ_DEV=1`, or a `.dev-data` directory | Development behaviour: Let's Encrypt **staging**, `-dev` process names, the legacy migration skipped |

Every installed background service passes `EASY_DEVOPS_DATA_DIR` so the service
and the CLI agree on one location. That alone used to set `devDataDir`, which
made a real install issue staging certificates on real domains.

**`POST /api/hub/connect`** also returns `agentOwner`: `"daemon"` when a
background service is running and will pick up the new pairing (with a `detail`
string saying so), or `"dashboard"` when this process holds the agent itself.
Only one process may hold an agent — the Hub keeps a single socket per server
and evicts the older one, so two would evict each other indefinitely.

`PUT /api/hub/permissions` takes leaf ids (`{ "nginx.reload": true }`) or whole
groups (`{ "groups": { "nginx": true } }`). Unknown and `comingSoon` ids are
ignored, so a malformed request cannot widen access.

### 2.7 Service and processes — `src/dashboard/routes/processes.js` (mounted at `/api`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/service` | session | Background-service state |
| POST | `/api/service/start` | session | Start the background service |
| POST | `/api/service/stop` | session | Stop it — temporarily |
| POST | `/api/service/restart` | session | Stop then start it |
| GET | `/api/processes` | session | PM2 process list |
| GET | `/api/processes/:name/logs` | session | Recent lines for one process |
| POST | `/api/processes/:name/:action` | session | `action` ∈ `start`, `stop`, `restart`, `reload` |

> **This section describes the NATIVE background service.** Easy DevOps used to
> run itself as a PM2 app named `ez-dashboard`, started at boot by a Windows
> Task Scheduler task that needed the user's **password**. All of that is gone.
> The service is now a systemd unit, a real Windows Service via WinSW, or a
> Startup-folder supervisor, and **no password is ever requested in any mode** —
> the Windows service runs as the virtual account `NT SERVICE\EasyDevOps`.
>
> The PM2-era daemon fields were **removed** from `GET /api/service`:
> `installed`, `running`, `status`, `app`, `appName`, `enabledOnBoot`,
> `bootMode`, `bootDetail`, `sameUser`, `currentUser`, `appUser`, `pm2Home`,
> `daemonRunning`, `canInstallFromDashboard`, `cliHint`. They described a PM2
> app that no longer exists, and on a machine where the daemon WAS running they
> reported `installed: false, running: false` — so a client reading them showed
> "Not installed" over a working service.

**`GET /api/service`** response `200`:

```json
{
  "backgroundService": { "…": "see below" },
  "pm2": { "installed": true, "version": "6.0.14", "path": "C:\\…\\pm2.cmd" },
  "dev": false,
  "dataDir": "C:\\Users\\me\\AppData\\Roaming\\easy-devops",
  "install": { "command": "ezz service install", "needsElevation": false, "shell": null },
  "probes": { "ageMs": 2800, "fresh": true, "pending": false, "refreshing": false }
}
```

`pm2`, `dev`, `dataDir` and `install` are what remains true: PM2 is still how
the **user's own** applications run (the Processes page below), `dev` drives the
dev badge, and `install` is the per-mode guidance for a client that cannot
elevate itself. Reading `pm2` never starts a PM2 daemon — every pm2 command
would, so the pid file is checked first.

#### Cheap facts now, measured facts when they are ready

This endpoint took about **twenty seconds** on a Windows machine. Nothing in it
was slow by itself: it made about six subprocesses, in sequence, and on that
machine one subprocess through PowerShell costs about a second (`where.exe pm2`
2.0 s, `pm2 --version` 4.0 s, `schtasks /Query` 1.7 s).

So the response is now built from two kinds of fact:

| | read | cost |
|---|---|---|
| The daemon lock, its heartbeat, whether a stop was requested, what install recorded, the data directory | **fresh on every request** | microseconds |
| The service manager's view, the pinned runtime's version, legacy PM2 leftovers, PM2 detection | from a cache, refreshed in the background | one subprocess each |

The cached probes run **in parallel** when they do run, and the dashboard warms
them when it starts. Measured after the change: a warm call about **3 ms**, and
the first call after a start about **1.6 s**, bounded by a deadline rather than
by how slow the probes happen to be.

`probes` describes the measurement, not the service:

| Field | Meaning |
|---|---|
| `ageMs` | Age of the oldest cached probe in this response |
| `fresh` | Every probe is within its lifetime. `false` means a refresh is running behind this response |
| `pending` | At least one probe has **never** completed, so the fields it fills are `null` (see below). Ask again shortly |
| `refreshing` | A background refresh is in flight |

**While `pending` is true**, only the measured fields are unavailable:
`state`, `enabledOnBoot`, `restarts`, `crashLooping`, `runtime` and the
`warnings` derived from them. Everything a client needs to render the banner —
`running`, `installed`, `mechanism`, `mode`, `startsAt`, `stoppedByUser`,
`pid`, `version`, `heartbeatAgeMs` — comes from the cheap half and is always
real. A client should render immediately and re-fetch rather than block.

The cache is dropped, so the next read re-measures, when any of these happens:
one of the three lifecycle endpoints above, `ezz service install`,
`ezz service uninstall`, `ezz service repair`, a runtime update, and whenever
`service:changed` (§3.1) fires — which covers a change made by
`ezz service start` in another process. A TTL per probe is the
backstop for a change made outside Easy DevOps entirely, such as `sc stop`.

`ezz service status` in the terminal does **not** use the cache: someone typing
that command is asking because something changed, so it measures afresh — in
parallel, which took it from about 7.5 s to about 2 s.
#### `backgroundService` — the single authority

```json
{
  "running": true,
  "connected": true,
  "pid": 51404,
  "version": "2.0.0",
  "startedAt": 1794691485390,
  "heartbeatAgeMs": 1200,

  "jobsRunningHere": false,
  "jobsOwnerPid": 51404,
  "jobsOwnerRole": "daemon",

  "mechanism": "startup-supervisor",
  "mode": "personal",
  "installed": true,
  "startsAt": "logon",

  "stoppedByUser": false,
  "stoppedAt": null,

  "dataDir": "C:\\Users\\me\\AppData\\Roaming\\easy-devops",
  "serverMode": false,
  "detail": "pid alive, heartbeat fresh",

  "state": "installed (starts at logon)",
  "enabledOnBoot": true,
  "restarts": 0,
  "crashLooping": false,
  "warnings": [],
  "serviceVersion": "1.4.6",
  "cliVersion": "1.4.7",
  "versionDrift": true,
  "runtime": {
    "systemNode": { "path": "C:\\Program Files\\nodejs\\node.exe", "version": "v22.21.1", "abi": "127" },
    "pinned": { "kind": "recorded", "path": "…", "version": "v22.21.1", "exists": true, "broken": false },
    "manager": { "managed": false, "manager": null },
    "warnings": []
  }
}
```

| Field | Meaning |
|---|---|
| `running` | A daemon holds the lock, so monitoring survives closing the dashboard |
| `connected` | **This** dashboard has a live IPC event channel to it. Narrower than `running`: a daemon whose IPC failed to bind is still working |
| `installed` | A native install exists. **Not derivable from `running`** — a daemon started by hand runs without being installed, and a stopped service is installed without running. This is `null` when the service files exist but Windows denied inspection; `detail` explains the permission error |
| `mechanism` | `systemd` \| `winsw` \| `startup-supervisor` |
| `mode` | `personal` \| `server` \| `null` (Linux) |
| `startsAt` | `logon` (Windows Personal) or `boot` |
| `jobsRunningHere` | This process is the one running the jobs. Exactly one process does, enforced by a marker — see §3.5 |
| `stoppedByUser` | Stopped deliberately, not crashed. `stoppedAt` is an ISO timestamp when known |
| `warnings` | Human-readable problems from the service status: a crash loop, a broken runtime pin, an unfinished install, missing live access for the service account, or a service/CLI version drift. Since 1.4.8 the access warnings come from the ACLs as they are now, never from the install record |
| `runtime` | The service's pinned Node next to the system's, so a version-manager break is visible |
| `serviceVersion` | The version of the package the service actually runs. Windows Server has its own copy under `C:\ProgramData\easy-devops\runtime\app`; Linux and Personal run the CLI package, so the two are equal. `null` when no service is registered, or when it cannot be read. 1.4.7 printed the CLI's own version here even with no service installed, so the field looked installed when nothing was |
| `cliVersion` | The version of the package this dashboard/CLI is running |
| `versionDrift` | `true` when `serviceVersion` and `cliVersion` differ, and only while a service is registered, so it is always `false` when `serviceVersion` is `null`. A file read, not a probe, so it is never stale. No automatic repair: the client names `ezz service repair` |

`enabledOnBoot` is `true`, `false`, or **`null` for unknown** (a non-systemd
Linux, where the boot hook cannot be read).

`core/service/index.js` `status()` also computes `serviceInstalled`,
`installProgress` (with `installUnfinished`) and `liveGrants` for the CLI and its
status lines. `GET /api/service` and `service:changed` do not publish them, so
the `backgroundService` shape above is unchanged and a dashboard cannot read
install progress over HTTP.

**Version drift is reported, never repaired automatically.** On Windows Server
the service runs its own copy of the package, so a plain `npm i -g easy-devops`
updates only the CLI. `serviceVersion`, `cliVersion` and `versionDrift` let a
client show "The background service runs vX, the installed package is vY. Run
`ezz service repair` as administrator." The same fact is published in the Hub's
`service:state` payload (`versionDrift`) and raised once per version pair as a
`notification:new` event of type `service_drift`; no new socket event is added.
The daemon also re-checks it at start and every six hours.

#### Lifecycle: start, stop and restart

No body. On success, `200`:

```json
{ "ok": true, "action": "start", "output": null, "backgroundService": { "…": "the new state" } }
```

Every response — success or failure — carries the resulting
`backgroundService`, so a client never has to follow up with `GET /api/service`.

`stop` is **temporary**: it records "stopped by you" and the service comes back
at the next logon or boot. `ezz service uninstall` is the permanent removal,
and is deliberately not exposed over HTTP. `restart` clears that marker.

Failures are machine-readable rather than opaque:

| Status | `error` | When | Also carries |
|---|---|---|---|
| `403` | `elevation_required` | Windows Server mode needs an Administrator context; systemd needs sudo | `command`, `shell` |
| `409` | `not_installed` | No native install to act on | `command` (`ezz service install`) |
| `409` | `already_running` | `start` with a daemon already up | — |
| `500` | `action_failed` | The mechanism refused for another reason | `message` |

```json
{
  "error": "elevation_required",
  "action": "stop",
  "message": "Stopping the Windows service needs an Administrator terminal.",
  "command": "ezz service stop",
  "shell": "Administrator PowerShell",
  "backgroundService": { "…": "unchanged" }
}
```

**The dashboard never elevates and never prompts for a password.** It cannot:
an Administrator context and a sudo prompt both need a terminal the user
controls. So the honest answer is the exact command and the shell to run it in.
In Windows **Personal** mode no elevation is involved at all — the daemon runs
as the same user as the dashboard — so start, stop and restart simply work.

**`GET /api/processes`** response `200`:
```json
{ "pm2": "…", "apps": [ /* see below */ ], "currentUser": "…", "pm2Home": "…", "hint": "…" }
```
`pm2Home` and `hint` are only present when there is something worth telling the
user (for example, PM2 is on a different `PM2_HOME` than expected). Each item of
`apps` is:
```json
{
  "name": "easy-devops",
  "pmId": 0,
  "pid": 12345,
  "status": "online",
  "cpu": 0,
  "memoryBytes": 52428800,
  "startedAt": 1731500000000,
  "uptimeMs": 3600000,
  "restarts": 0,
  "unstableRestarts": 0,
  "execPath": "/usr/bin/node",
  "cwd": "/opt/easy-devops",
  "user": "deploy",
  "managed": true,
  "dataDir": "/home/deploy/.config/easy-devops"
}
```

**`GET /api/processes/:name/logs`** response `200`:
```json
{ "name": "easy-devops", "lines": ["...", "..."] }
```
`lines` is an array of strings, one per log line. The `lines` query parameter
controls how many are returned: it is clamped to the range 1–5000 and defaults
to 200 —
`Math.max(1, Math.min(5000, Number(lines) || 200))` in `src/core/runner.js`.

`POST /api/processes/:name/:action` errors: `400` unknown action · `404` PM2 has
no such process · `409` PM2 not installed, or the process belongs to another OS
user (PM2 keeps one process list per user).

### 2.8 Deployments — `src/dashboard/routes/deployments.js` (mounted at `/api/deployments`)

Added in 2.4.0. Puts a project from a git repository on the server, builds it
there, runs it under PM2 and keeps earlier releases to roll back to. All of it
is `core/deploy/`; these routes are a thin layer over it.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/deployments` | session | Apps, hook status, requirements |
| POST | `/api/deployments` | session | Create an app |
| GET | `/api/deployments/hook` | session | Deploy-hook settings and status |
| PUT | `/api/deployments/hook` | session | Change the deploy-hook settings |
| GET | `/api/deployments/:id` | session | One app with its runs and releases |
| PUT | `/api/deployments/:id` | session | Update an app |
| DELETE | `/api/deployments/:id` | session | Stop the app, forget it, delete its files |
| PUT | `/api/deployments/:id/domain` | session | Link the app to a domain (created if it does not exist) |
| DELETE | `/api/deployments/:id/domain` | session | Forget the link; the domain is untouched |
| POST | `/api/deployments/:id/move` | session | Move the app's folder elsewhere on the server |
| POST | `/api/deployments/:id/deploy` | session | Start a deployment |
| POST | `/api/deployments/:id/rollback` | session | Switch back to an earlier release |
| DELETE | `/api/deployments/:id/releases/:releaseId` | session | Delete an old release's folder |
| GET | `/api/deployments/:id/runs/:runId` | session | One run, with the tail of its log |
| POST | `/api/deployments/:id/hook-token` | session | Issue (or replace) the app's deploy token |
| DELETE | `/api/deployments/:id/hook-token` | session | Revoke it |
| POST | `/api/deployments/:id/deploy-key` | session | Generate (or replace) the SSH deploy key |
| POST | `/api/deployments/:id/deploy-key/test` | session | Test that the key can read the repository |
| POST | `/api/deployments/:id/deploy-key/github` | session | Add the public key to GitHub as a read-only deploy key |
| GET | `/api/deployments/:id/github` | session | Workflow file, secrets and URL for GitHub Actions |
| POST | `/api/deployments/:id/github/apply` | session | Do the GitHub steps through GitHub's API |

**The app object** (returned by create, update, `GET /:id`, and in `apps[]`):

```json
{
  "id": "my-api",
  "pm2Name": "ez-my-api",
  "repoUrl": "git@github.com:me/my-api.git",
  "branch": "main",
  "authType": "deployKey",
  "hasToken": false,
  "deployKey": "ssh-ed25519 AAAA… easy-devops-deploy-my-api",
  "deployKeyFingerprint": "SHA256:…",
  "deployKeyCreatedAt": "2026-11-19T…",
  "deployKeyOnDisk": true,
  "settings": { "runtime": "node", "port": 3000, "healthPath": "/healthz", "steps": [{ "run": "npm ci", "kind": "install", "enabled": true }, { "run": "npx prisma migrate deploy", "kind": "migrate", "enabled": true }], "persist": ["data", "uploads/imgs"] },
  "env": { "DATABASE_URL": "…" },
  "keepReleases": 5,
  "autoRollback": true,
  "notifyChannelIds": [],
  "warnings": [],
  "dir": "/home/me/.config/easy-devops/ez_deploys/my-api",
  "sharedDir": "/home/me/.config/easy-devops/ez_deploys/my-api/shared",
  "hasSharedData": true,
  "hook": { "hasToken": true, "tokenHint": "x9Qz", "createdAt": "2026-11-15T…" },
  "createdAt": "…", "updatedAt": "…"
}
```

- `id` — 1–40 characters, lower-case letters, digits and dashes. It is the
  directory name, the URL segment and (prefixed with `ez-`) the PM2 name, and
  cannot be changed after creation.
- `authType` — `none` (public repository) | `deployKey` (SSH URL; generate the
  key with `deploy-key` and add its public half to the repository) | `token`
  (https URL; a personal access token sent as an HTTP header, never written
  into the checkout).
- The token itself is **never returned**; `hasToken` says whether one is
  stored. The private deploy key is never returned by any endpoint.
- `env` values **are** returned: this is where they are edited, behind the
  dashboard's own login. They are not included in anything sent to a Hub.
- `settings` are overrides. Any of `steps`, `runtime`, `pre`, `post` (string, list
  of strings, or `false` to switch the step off), `start` (one command), `port`,
  `healthPath`, `healthTimeout` (seconds), `instances`, `execMode`, and `persist`
  (a folder or a list of folders kept across releases — see below). Absent means
  "use ez.json, then package.json", and the defaults are `runtime: "node"`,
  `execMode: "fork"` with `instances: 1`.
- `steps` (2.15.0) — an ordered list of at most **5** steps run in the new
  release directory after checkout and before the release is started. Each step
  is `{ run, kind, enabled? }`: `run` is one non-empty command line (the same
  validation as the old command fields), `kind` is `install`, `build`,
  `migrate` or `custom`, and `enabled` defaults to `true`. Disabled steps are
  skipped and logged as skipped. A non-zero exit aborts the deployment at that
  step and leaves the running release untouched. `install`/`build`/`migrate`
  keep their old behaviour (`migrate` still runs with the forward-only hint),
  and `custom` has none. The run record's `step` is the kind, or `step N`
  (1-based list position) for a custom step; the record also carries `stage`
  and `skippedStages` (see the run object below). `steps` is also read from `ez.json`
  and is one field for precedence: the first layer that states it wins the whole
  list — an app setting replaces the list from `ez.json`, and `[]` clears it. An
  older app that still stores `install`/`build`/`migrate` keeps winning over a
  `steps` list in a **lower** layer such as `ez.json`: those fields are read as
  the list and the response warns that the app's commands were used, so save
  them as steps to make it explicit. Skipping in
  the old format (`false` or an empty list) becomes an omitted step; in the new
  format it is `enabled: false`.
- `runtime` (2.15.0) — the runtime the app runs on. `"node"` is the only value
  accepted today and is the default; the server models it as a list so others
  can be added. `execMode: "cluster"` is only available for `runtime: "node"`;
  any other combination is a `400` that says to use `node` or `fork`.
- The old `install`, `build` and `migrate` fields are still accepted in app
  settings and in `ez.json`, and are read as the equivalent `steps` list
  (`install` → `install`, `build` → `build`, `migrate` → `migrate`; a skipped
  field contributes no step). Inside one layer, `steps` wins when both are
  present and the response carries a warning that the old fields were ignored;
  a layer above may still contribute the old fields, as described above.
  Saving through the API with `steps` stores `steps`; the old fields are
  removed from the app.
- `migrate` (2.11.0, still supported as an alias) runs in the new release
  directory with the build's environment, after `build` and before the new
  release is started. A non-zero exit fails the run at the `migrate` step; the
  previous release keeps running untouched. Migrations are forward-only — a
  code rollback cannot undo a migration that already ran.
- `instances` — a whole number from `1` to the server's CPU count, or the
  string `"max"` (one per CPU). It is also read from `ez.json`. A number above
  the CPU count, a non-integer, or a non-number is a `400` naming the CPU
  count and what to use instead.
- `execMode` — `"fork"` (the default: one process) or `"cluster"` (PM2 cluster
  mode, one worker per instance). It is also read from `ez.json`. Cluster mode
  is accepted only when `start` runs a JS file directly (`node dist/index.js`,
  `node server.mjs`); an `npm`/`yarn`/`pnpm` script or a non-Node command is a
  `400` that names the direct `node <file>` form to use. `instances` above 1
  with `fork` is a `400` too: several forked copies would all bind the same
  port, so set `execMode: "cluster"`.
- `warnings` — an array of advisory strings. In cluster mode it contains the
  stateless warning: `Cluster mode runs several copies of the app; it must be
  stateless (no in-memory sessions, sockets, caches or schedulers that assume
  one process).` A step order that will probably fail is reported too, as a
  warning and never an error: `migrate` before `install`, `build` before
  `install`, or `migrate` before `build` (only enabled steps count), each
  saying which step to move. A warning never fails a request; the UI shows it
  next to the settings.

In `apps[]` and `GET /:id` each app additionally has `currentRelease`,
`previousRelease`, `deploying`, `activeRunId`, `lastRun` (a run object or
`null`), `execMode` and `instances` (the configured values from the live
release, else the app's settings, else `fork`/`1`), `instancesOnline` (how many
copies PM2 currently reports online; `0` when PM2 is not running) and
`process` (`{ status, pid, cpu, memoryBytes, uptimeMs, restarts }`, or `null`
when PM2 is not running — the list never starts a PM2 daemon). `GET /:id` adds
`runs` (newest first, up to 20) and `releases`
(`[{ id, sha, ref, startable, current, previous, execMode, instances }]`).

**Cluster mode and reloads.** A cluster app is written to its PM2 config as
`exec_mode: "cluster"` with `instances`. When the app is already running under
the same PM2 name in cluster mode, a deployment (and a rollback) uses
`pm2 reload` instead of delete-and-start, so there is no downtime. A first
deployment, or a switch between fork and cluster, uses the ordinary
delete-and-start. The boot-crash check watches every worker: any instance that
is errored, stopped or restarting fails the release and triggers the normal
automatic rollback. The previous release's mode is recorded in its release
metadata, which is what a rollback follows.

**`GET /api/deployments`** also returns `hook` (below), `requirements`
`{ git, gitVersion, pm2 }`, `limits`, `ezFileLocations`, `channels`
(`[{ id, name, type }]`) and `domains` (`[{ name, enabled, ssl }]`).

Changing `repoUrl` discards the saved credential. A token-authenticated replacement origin requires a new token in the same request.

**`POST /api/deployments`** takes `{ id, repoUrl, branch?, authType?, token?,
generateKey?, settings?, env?, keepReleases?, autoRollback?, notifyChannelIds? }`
→ `201` with the app. `generateKey` is a boolean and is ignored unless
`authType` is `deployKey`; it defaults to `true` for a deploy-key app. When it
is true the key is generated in the same request, **without starting a
deployment**, and the response is the app view plus a `deployKey` object —
`deployKey: { publicKey, fingerprint, createdAt, addUrl }` — which replaces the
public-key string that field normally carries, where `addUrl` is
`https://github.com/OWNER/REPO/settings/keys/new` for a github.com repository
and `null` otherwise. If generation fails the app still exists and the response
is `201` with `deployKeyError` (the message) instead. `400` `{ error, errors[] }`
on invalid input, `409` when the id is taken. `PUT /:id` takes any subset of the
same fields except `id` and `generateKey`. `settings` accepts `steps` and
`runtime` (2.15.0) and still accepts the old `install`/`build`/`migrate` fields;
an update that carries `steps` stores it and drops the old fields.

**Step order warnings (2.15.0).** Validation and app responses carry them in
`warnings`, not `errors`: a `migrate` step before `install`, a `build` before
`install`, or a `migrate` before `build` will probably fail, so the warning says
which step to move. Disabled steps do not count.

**Folders (2.6.0).** Every app has `dir`, the folder it lives in
(`<dir>/releases`, `<dir>/logs`, …). It is recorded when the app is created —
`<deployDir>/<id>`, where `deployDir` is the setting in §2.5 (default
`<data dir>/ez_deploys`) — and **changing the setting never moves an existing
app**: each keeps the folder it was created in. An app created before 2.6.0
stays in `<data dir>/deploy/<id>`. `GET /api/deployments` returns `deployDir`,
where a new app would be created.

**`POST /:id/move`** takes `{ path }` — the **parent** folder; the app ends up
in `<path>/<id>`. In order: its PM2 process is stopped, the folder is moved
(a rename, or a copy when the destination is on another disk), the new
location is recorded, and the live release is started again. Response `200`
`{ from, to, restarted, warning }`; `restarted` is false when the app was not
running, and `warning` is set when it was running but could not be started
again. `400` for a path that is not absolute or contains characters a shell
would act on; `409` when the destination exists and is not empty, when the app
is already there, or while a deployment of it is running. If the move itself
fails nothing has changed and the process is started again where it was.

**Persistent paths (2.8.0).** `settings.persist` lists project-relative
folders — or single files, such as `prisma/hub.db` — kept outside the
releases: each lives once in `<dir>/shared/<path>` and is linked into every
release at the same path. `sharedDir` is that location and `hasSharedData`
says whether it holds anything. A path already in the shared area wins. When
it is new, the kind comes from the live release's copy, then from the
checkout, and failing both from its name (a last segment with a dot is a
file); a folder is seeded from the checkout and then the live release on top,
a file from the live release and then the checkout, and a path that exists
nowhere is created empty. Enabling it on an app that already ran seeds from
its live release, so data written before is not lost. On Windows without the
symlink privilege folders use junctions and files hard links, and the link is
checked after the build. Paths are validated in `core/deploy/ezfile.js`:
relative, no `.` or `..`, not `.git` or `node_modules`, at most 20, no
case-insensitive overlap. A build that replaces a link with a real file or
folder fails the deployment at the `build` step.

**`DELETE /:id/releases/:releaseId`** deletes that release's folder. The
run's log stays and `<dir>/shared` is not touched. Response `200`
`{ deleted }`; `400` for an id that is not a release id, `404` for an unknown
app or a release that is no longer on disk. `409` when a deployment of the app
is running, when the release is the live one, and when it is the one an
automatic rollback would return to.

**Domains (2.6.0, extended 2.12.0).** Every app has `domain`, the name of the
domain linked to it, or `null`. **`PUT /:id/domain`** takes:

```json
{
  "domain": "example.com",
  "www": false,
  "ssl": { "mode": "none | issue | existing", "certName": "example.com" },
  "redirect": true,
  "behindCloudflare": false,
  "opId": "link_7f3c2a91"
}
```

`www` and `behindCloudflare` default to `false`. `ssl` defaults to
`{ "mode": "none" }`; the legacy `{ "domain", "ssl": true | false }` still
works, where `true` means `issue` and `false` means `none`. `redirect` defaults
to `true` when `ssl.mode` is not `none` and is ignored for `none`. These are the
same validators and the same domain record the Add-domain page uses, so the
nginx config comes from `nginx-conf-generator.js` unchanged.

`opId` (2.17.0) is optional and is the client's correlation id for the live
progress event; it must match `/^[A-Za-z0-9_-]{8,64}$/` or the answer is `400`
`{ "error": "invalid_opId", "detail": … }`. An absent value means the server
generates one. Once accepted, every response — the `200`, the `400` for a bad
domain and the `409` for a missing port — carries the effective value as
`opId`.

- `none` — no certificate is requested; an existing domain's SSL settings are
  left alone.
- `issue` — a new certificate is requested over HTTP-01 (also covering
  `www.<domain>` when `www` is true), using the configured ACME email. A
  wildcard name, or any request for a new DNS-01 wildcard, is refused with
  `400`: "A new wildcard certificate needs DNS validation, which linking does
  not do. Issue it from the SSL page, then link with an existing certificate."
- `existing` — `certName` must name a certificate the server's own suggestion
  returns for this domain (and for `www.<domain>` when `www` is true).
  `certPath`/`keyPath` from the caller are ignored; only the paths in the
  server's suggestion are used. When no suggested certificate covers the
  name(s), or `certName` does not match it, the answer is `400` with the
  reason.

An existing domain is re-pointed at the app's port; an unknown one is created.
The app needs a port — set on it, or taken from its live release — otherwise
`409`. The domain + nginx link is applied first: if issuance then fails, the
link still stands over HTTP and the result says why and what to do next.
Issuing is slow and this dashboard request is **synchronous** — it answers when
issuance finishes, exactly like `POST /api/ssl/create`.

Response `200`:

```json
{
  "ok": true,
  "opId": "link_7f3c2a91",
  "domain": "example.com",
  "created": true,
  "port": 3000,
  "www": false,
  "behindCloudflare": false,
  "ssl": { "mode": "issue", "ok": true, "detail": "…", "certName": "example.com" },
  "redirect": true,
  "nginxReloaded": true
}
```

A failed link answers its own status with `{ "error": "…", "opId": "…" }` — one
line with the cause and what to do next, not a staged error object.

While the link runs it publishes the same **`ssl:progress`** event as §3.1, on
the existing bus, with `domain` set to the linked name and the stages listed for
`linkDomain` in §3.5. There is no new route and no second event: a dialog that
already listens for issuance progress uses the `opId` it sent to tell its own
run apart.

`ssl` is `null` for `none`. It never contains key file contents. The result is
an ordinary domain: it appears in `GET /api/domains` and is edited there. After
every successful deployment a linked domain is moved to the app's port if that
changed. **`DELETE /:id/domain`** forgets the link and leaves the domain as it
is.

**`DELETE /:id`** accepts `?deleteDomain=1` to remove the linked domain as
well, and `?purgeData=1` (or `{ "purgeData": true }`) to delete the persistent
folders too. Without it `<dir>/shared` is kept — an empty one is removed with
the rest. Response `{ deleted, domainDeleted, warning, sharedKept, sharedPath }`;
when the domain could not be removed the app is deleted anyway and `warning`
says so.

**The run object:**

```json
{
  "id": "20261115-214502-3fa9c1",
  "appId": "my-api",
  "trigger": "manual",
  "actor": "dashboard",
  "ref": "main",
  "sha": "9f2c…",
  "releaseId": "20261115-214502-3fa9c1",
  "status": "running",
  "step": "build",
  "stage": "build",
  "skippedStages": ["migrate", "post"],
  "startedAt": 1794000000000,
  "finishedAt": null,
  "error": null,
  "warnings": [],
  "rolledBackTo": null,
  "reason": null,
  "logTail": [],
  "rollbackSucceeded": null
}
```

- `trigger` — `manual` | `webhook` | `hub` | `rollback`.
- `status` — `running` | `success` | `failed` | `rolled_back`. `rolled_back`
  means the new release stayed online under PM2 but its health check failed,
  and the previous release is running again (`rolledBackTo` names it).
  `failed` with `rollbackSucceeded: true` means the new release crashed at boot
  (PM2 reported it errored/stopped or kept restarting) and the previous release
  was restored; what was deployed never worked.
- `step` — `fetch` → `settings` → `pre` → the list's steps in order →
  `start` → `health` → `post` → `finish` → `done`. A step's value is its
  `kind` (`install`, `build` or `migrate`), or `step N` (1-based list position)
  for a `custom` step. On a failure it stays at the step that failed; a failed
  migration is `migrate`, a failed custom step is `step N`.
- `stage` (2.17.0) — the canonical stage the run is in, for a stage bar that
  both the dashboard and the Hub can draw: `fetch`, `settings`, `pre`,
  `install`, `build`, `migrate`, `start`, `health`, `post`, `finish`, or `done`
  once the run succeeded. It is a reserved step's own id, or — for a `custom`
  step, which has no stage of its own — the install/build/migrate stage it
  continues, `build` otherwise. A failure keeps the stage it failed in. The
  rollback run (`trigger: "rollback"`) goes `start` → `health` → `done`.
- `skippedStages` (2.17.0) — the stages this run does not perform, in bar
  order: `pre` when there is no pre hook, `post` when there is no post hook,
  and `install`/`build`/`migrate` when no enabled step maps to them. It is `[]`
  until the settings have been read, and for a rollback it is
  `["fetch","settings","pre","install","build","migrate","post"]`.
  **Old agents send neither `stage` nor `skippedStages`; readers fall back to
  `step` and show no skipped stages.**
- `reason` (2.11.0) — a short explanation, set on a boot crash or health
  failure: `crashed at boot: restarting N times`, `crashed at boot: process is
  "errored"…`, or `health check failed: …`. `null` otherwise.
- `logTail` (2.11.0) — on a boot crash, the last ~40 lines of the new release's
  PM2 out+error log. Every value of an environment variable on the app is
  replaced with `***`; the array is empty when there was no crash or PM2
  produced nothing.
- `rollbackSucceeded` (2.11.0) — `true`/`false` once an automatic rollback was
  attempted and the previous release was (or was not) verified healthy; `null`
  when nothing was attempted — a first release with nothing to return to, or
  `autoRollback: false`. A first release that crashes at boot is stopped.
- `GET /:id/runs/:runId` adds `log` (the last 64 kB of the run's output) and
  `logTruncated`. There is no socket event for deployments: a client polls
  this while `status` is `running`.

**`POST /:id/deploy`** takes `{ ref? }` (a branch, tag or commit; defaults to
the app's branch) → `202` `{ runId, status: "running" }`. `409`
`{ error, runId }` when a deployment of that app is already running.
**`POST /:id/rollback`** takes `{ releaseId? }` (defaults to the previous
release) → `202`, or `409` when there is nothing to roll back to. Neither
waits for the work to finish.

**`POST /:id/hook-token`** → `{ token, tokenHint }`. This is the **only**
response that contains the token: only its SHA-256 is stored. Issuing a new one
invalidates the old one.

**`POST /:id/deploy-key`** regenerates the app's ed25519 deploy key and writes
the private half to `<dir>/id_deploy` with owner-only permissions. The private
key is never returned, logged or stored in the registry. It requires an app with
`authType: "deployKey"` and an SSH `repoUrl` (`400` otherwise) and answers
`409` while a deployment of the app is running: "A deployment is running;
regenerate the key after it finishes." Response `200`
`{ publicKey, fingerprint, createdAt, previousFingerprint, addUrl }`.

**`POST /:id/deploy-key/test`** runs `git ls-remote --heads` with the app's key,
pinning GitHub's published host keys (`StrictHostKeyChecking=yes`; never
`accept-new`) and a 12-second timeout, which stays inside the Hub's 15-second
quick-command window. The result is passed through as-is:
`{ ok, status, error, detail?, branchFound?, fingerprint? }`. A completed test
answers HTTP `200` even when `ok` is `false`; `404` (unknown app), `400` (not an
SSH URL, or not github.com), `409` (no key yet) and `500` (unsafe app path) are
passed through. It never prompts.

**`POST /:id/deploy-key/github`** takes `{ token }` — a GitHub token typed for
this request, used once and forgotten (never stored, logged or echoed). When
`token` is omitted the app's own token is used if `authType` is `token`. It adds
the current public key to the repository as a **read-only** deploy key titled
`Easy DevOps — <appId>`, and removes an older key with the same title and a
different key material if one exists. Response `200`
`{ ok, steps: [{ id, ok, detail }], error }`; step ids are `deployKey` and,
when an old key was removed, `oldKey`. A GitHub refusal (including a token that
cannot reach the repository) answers `422` with the explanation in `error` and
the same `steps`. `400` when the repository is not on github.com or no usable
token is available; `409` when no deploy key has been generated yet. This is the
same function `POST /:id/github/apply` uses for its `deployKey` step.

The deploy itself uses the same SSH command as the test: a github.com URL pins
GitHub's published host keys with `StrictHostKeyChecking=yes`; another SSH host
keeps `accept-new`, because there is no published key to pin. The private key
stays at `<dir>/id_deploy` (mode 600) and never appears in a response, log,
event or Hub payload. An app's older RSA key keeps working until it is
regenerated.

**`GET /:id/github`** → `{ hookUrl, hookMode, hookSecure, hookNote, hasToken,
tokenHint, workflowPath, workflow, secrets: [{ name, value }], deployKey }`.
`secrets[].value` is `null` for the token (see above) and for the URL when the
hook is not reachable from outside.

Since 2.5.0 it also returns `targets`: the two ways GitHub can reach this
server, for the user to choose between. `hookUrl` above is still the direct
one.

```json
"targets": [
  { "id": "hook", "label": "This server’s deploy hook", "url": "https://example.com/.ez-deploy/my-api", "secure": true, "note": "…" },
  { "id": "hub",  "label": "Through the Hub", "url": "https://hub.example.com/api/v1/hooks/deploy/<serverId>/my-api", "secure": true, "note": "…", "ready": true }
]
```

The `hub` target has `url: null` on a server that is not paired, and
`ready: false` until the server grants `deploy.ci` (Settings → Hub). Both
targets accept the same request with the same deploy token — the Hub forwards
it over the agent connection and **the server** verifies the token — so the
workflow file is identical; only the value of `EZ_DEPLOY_URL` differs.

**`POST /:id/github/apply`** (2.5.0) takes `{ token?, target?: "hook" | "hub",
secrets?, workflow?, deployKey? }` — the three booleans default to `true`
(`deployKey` only applies to a deploy-key app). `token` is a GitHub token with
write access; when omitted, the app's own access token is tried. A token sent
here is used for this request and not stored.

It issues a **new** deploy token (the previous one stops working), stores
`EZ_DEPLOY_URL` and `EZ_DEPLOY_TOKEN` as encrypted repository secrets, commits
the workflow file to the app's branch and adds the deploy key read-only. The
deploy token is never returned. Response `200`:

```json
{
  "ok": false,
  "repo": "acme/my-api",
  "error": null,
  "target": "hook",
  "deployUrl": "https://example.com/.ez-deploy/my-api",
  "steps": [
    { "id": "secrets",   "ok": true,  "detail": "Stored EZ_DEPLOY_URL and EZ_DEPLOY_TOKEN." },
    { "id": "workflow",  "ok": false, "detail": "GitHub refused (403…). The token needs “Contents: read and write” and “Workflows: read and write” on this repository." },
    { "id": "deployKey", "ok": true,  "detail": "Added the deploy key, read-only." }
  ]
}
```

Each part is attempted independently, so `ok` is true only when every
requested step succeeded. `502` with `error` set when GitHub could not be
reached or the token cannot see the repository (no step was attempted).
`400` when the repository is not on github.com or no usable token is
available; `409` `{ error, reason: "no_deploy_url" | "no_deploy_key" }` when
there is nothing to put in the secret yet. If the secrets step fails, the
token issued for it is revoked rather than left unknown to everyone.

**The deploy hook settings** (`GET` / `PUT /api/deployments/hook`):

```json
{
  "enabled": true, "port": 6445, "bind": "127.0.0.1", "domain": "example.com",
  "listening": true, "path": "/.ez-deploy/",
  "urlExample": "https://example.com/.ez-deploy/your-app",
  "mode": "domain", "secure": true, "note": "Reached through example.com over HTTPS."
}
```

`PUT` takes any subset of `enabled`, `port`, `bind` (`127.0.0.1` | `0.0.0.0`)
and `domain` (a configured domain name, or `null`). Choosing a domain rewrites
that domain's nginx config to forward `/.ez-deploy/` to the listener and
reloads nginx; if nginx rejects the result the setting is not changed and the
answer is `500` `{ error, detail }`. The response adds `nginxReloaded` and
`appliesWithinSeconds` — the listener runs with the background jobs, usually
in another process, and re-reads the setting on a timer.

`mode` is `domain` (through nginx), `direct` (bound to every interface — plain
HTTP, `secure: false`) or `none` (not reachable from outside).

---

---

## 3. Socket.io events

One namespace (the default), on the dashboard's own port. The handshake runs the
same express-session middleware as HTTP, then the transport checks of §1, then
the session check.

**The browser client must not force `transports: ['websocket']`.** Browsers
cannot set headers on a WebSocket upgrade, so `X-EZ-Request` would never arrive.
socket.io's default order starts with HTTP polling, where `extraHeaders` does
apply, and the handshake is authenticated there before any upgrade.

### 3.1 Server → client

The payloads below are unchanged by the daemon work. The "Produced by" column
now names where each event is **decided**, which is no longer the socket layer:
`core/jobs/` publishes to the in-process bus (`core/jobs/bus.js`) using these
exact names, and `socketManager.js` forwards each one to connected browsers
without touching it. When a daemon owns the jobs, the events cross from that
process over local IPC and `dashboard/lib/daemonBridge.js` republishes them
onto the same bus — so the browser cannot tell which process produced them,
and there is only one schema.

| Event | Payload | Produced by | Runs in the daemon? |
|---|---|---|---|
| `nginx:status` | `{ running, version, pid }` or `{ …, error }` | `core/jobs/monitors.js` — every 5s | **Yes** |
| `domain:health` | `[{ name, up, port, host }]`, `up: null` for external backends | `core/jobs/monitors.js` — every 60s | **Yes** |
| `notification:new` | `{ id, type, subtype?, severity, message, domain?, timestamp }` | `core/jobs/monitors.js` via `core/notifications/dispatch.js` — on nginx and domain-health transitions, on certificate expiry, and after each automatic renewal attempt (`type: "cert_expiry"`, `subtype: "renewed"` or `"renew_failed"`); also `core/daemon/run.js` once per service/CLI version pair (`type: "service_drift"`, `subtype: "newer_installed"`, plus `serviceVersion` and `installedVersion`) | **Yes** |
| `logs:line` | `{ line, logFile }` | `socketManager.js` — per line while a tail is active | **No** — a tail exists only for a watching client |
| `local:changed` | `{ section, source, at, …detail }`, `section` ∈ `domains`, `ssl`, `nginx`, `settings` | `core/hub/agent.js` after it applies a Hub command (`source: "hub"`), and `core/jobs/revisionWatcher.js` when another process moves the change counter (`source: "revision"`) | **Yes** |
| `service:changed` | the `backgroundService` object from §2.7, identically shaped | `dashboard/lib/daemonBridge.js` — whenever the background service or the jobs owner changes | **No** — it describes the service *as this dashboard sees it* |
| `hub:agentState` | `{ linked, connected, status, lastError, attempts }` (the same fields as `GET /api/hub/status`) | `core/hub/agent.js` — on every real state transition (connecting, connected, unreachable, rejected, not linked) | **Yes** — the agent lives in the job-owning process |
| `ssl:progress` (2.16.0) | `{ opId, domain, stage, status, detail?, elapsedMs, at }` — `status` is `running`, `ok`, `failed` or `skipped`; `stage` is one of the nine stages in §3.5; `detail` is at most 300 characters and never contains a key or file contents; `elapsedMs` is measured from the start of the operation; `at` is an ISO string | `core/ssl-issuer.js` / `core/cert-renewal.js` via `core/ssl/progress.js`, published on the job bus by the dashboard controller. At most five events per `opId` per second; over budget, the newest event of each stage is held and sent when the window reopens, so a stage's `running` → `ok`/`failed` pair is never lost | **No** — the request that started the operation publishes it |

**Replay on connect.** `nginx:status`, `domain:health` and `service:changed`
are state, so the server remembers the last payload of each and sends it to a
socket as soon as it connects. Without that, a tab opened just after a poll
would render empty until the next one — up to 60 seconds for domain health, and
for `service:changed` until the next hand-over, which may never come.
`notification:new` and `local:changed` are deliberately NOT replayed: they are
discrete events, and replaying them would announce outages that are already
over, or a change that was handled, to every new tab. `ssl:progress` (2.16.0)
is not replayed either: a stage is a moment in one operation, not state, so a
newly opened tab waits for the next event rather than seeing a stale
`waiting for validation`.

**`service:changed`** fires when any of this changes: a daemon started or
stopped, it was stopped by the user, the jobs moved between the daemon and this
dashboard, or the event channel connected or dropped. It is published only on a
real change — the dashboard watches the lock file, so an ordinary restart would
otherwise emit several times in a second. Its payload is byte-identical to
`backgroundService` in §2.7, so a client has one shape to render and can treat
`GET /api/service` as the initial fetch and this event as the live update.

### 3.2 Client → server

| Event | Payload | Handled by | Runs in the daemon? |
|---|---|---|---|
| `logs:subscribe` | `{ logFile: "error" \| "access" }` | `socketManager.js` — starts a `tail`/`Get-Content` child, replacing any existing tail for that socket | **No** — per-client, dies with the socket |
| `logs:unsubscribe` | none | `socketManager.js` — stops that tail | **No** |
| `disconnect` | — | `socketManager.js` — stops the tail, decrements the client count | **No** |

On **every** `logs:subscribe`, the server first replays the last 50 lines of
that log (`Get-Content -Tail 50 -Wait` on Windows, `tail -n 50 -f` on Linux),
then streams new lines as `logs:line` events as before. A client that keeps
its own buffer must clear it before each subscribe — otherwise a reconnect
re-appends the same 50 lines onto what it already had. This is called out
because that duplication bug has already been hit once.

### 3.3 Which process produces them

The dashboard process used to be both the UI server and the monitor, so those
events existed only while a browser was open. That split has happened: nginx
polling, domain health, certificate expiry, the notification decisions and the
Hub agent live in `core/jobs/` and run in whichever process owns the jobs —
`ezz daemon` (under the native service) when one runs, otherwise the open
dashboard. The event names and payloads above did not change, which is the
point: the browser cannot tell which process produced an event, and this
contract is the same either way.

Everything marked **Yes** in §3.1 belongs to the daemon, because it must keep
working with no browser open; when a daemon owns the jobs, its IPC frames are
republished onto the same bus and forwarded unchanged. Everything marked **No**
is inherently per-client and stays with whatever process is serving that socket.
The dashboard never takes the daemon lock, so starting the service does not
require closing a tab.

### 3.4 Commands the Hub sends to the agent

A separate surface from everything above: these arrive on the agent's **outbound**
socket to the Hub (`core/hub/agent.js`), not on the dashboard's socket, and no
browser can send them. They are listed here because the agent's handling of
them — and especially its permission checks — is part of what this project
promises.

Every command carries a `requestId` and is answered exactly once with
`command:result { requestId, ok, error, data }`. Every one is checked against
the local permission catalog by `checkCommandAllowed()` before it runs; the
agent is the authoritative gate, and the Hub's own check only exists so it can
answer 403 instead of reporting a dropped command as dispatched.

**Delivery.** When the Hub sends a command it may also pass a socket.io
acknowledgement callback as the second listener argument. A quick command
(everything that finishes in seconds — `getEnv`, `getConfigs`, `saveConfig`,
`getLogs`, deploy list/detail/status, SSL suggest, …) is sent with one, and
the agent calls it with the **same payload** it emits as `command:result`:

```js
socket.on('hub:getConfigs', async (payload, ack) => {
  const result = { requestId: payload.requestId, ok: true, error: null, data: { … } };
  if (typeof ack === 'function') ack(result);   // current Hub reads this
  socket.emit('command:result', result);        // older Hubs read this
});
```

The ack is called **first** and `command:result` is still emitted, always, so
an older Hub that only relays the event keeps working. The Hub resolves its
HTTP request from whichever arrives first (ack or event) and never twice. A
command that carries no `requestId` is not answered at all — there is nothing
to correlate it with.

Long-running commands (deploy, rollback, SSL issue/renew/renewAll, nginx
start/stop/restart, and `hub:manageDeploy { action: "linkDomain" }` when it
issues a certificate) are answered the same way but the Hub does not hold its
HTTP request open. On the Hub, `POST /servers/:id/command` answers within
**15 s** for a quick command and `202 { dispatched, command, requestId,
status: "pending" }` for a long one; a quick command that cannot be answered is
`409 AGENT_OFFLINE`, `424 AGENT_TIMEOUT` (naming the command and the 15 s) or
`422 AGENT_ERROR` with the agent's own message. The body keeps `error` and adds
`code`, and none of these is a 5xx: an origin 5xx behind Cloudflare may be
replaced by Cloudflare's own page, which would hide the agent's reason. Its
result can be collected later with `GET /servers/:id/commands/:requestId` — the
server's owner only, for **10 minutes** from completion, capped at 500 entries,
and `404` for anyone else's id. See `hub_backend/ARCHITECTURE.md` ("Commands").

`hub:manageSSL` `issue`, `renew` and `renewAll` (2.16.0) report live progress
through `command:progress` while they run; the frames use the stages and rules
in §3.5. No command or payload field is added: the correlation key remains the
existing `requestId`.

A refused command (1.4.2) answers `ok: false` with the message in `error` and,
for `hub:manageSSL` and `hub:manageDomain`, the handler's own result in
`data` (it was always `null` before). A quick command's `422 AGENT_ERROR` body
carries it as `data`, and the stored result keeps it:

- `hub:manageSSL { action: "issue", domain, www? }` — the name must pass
  `validateDomainName` and must not be a wildcard (DNS-01 is server-only).
  Success data: `{ ok, domain, certPath, keyPath, mode, fellBack, nginxDownMs,
  staging, summary, preflight }`. Failure data: `{ ok: false, domain,
  error: { stage, cause, fix, consequence }, preflight }`, `preflight` being
  `{ ok, detail, results: [{ id, status, message, fix? }], proxied }` or `null`.
- `hub:manageSSL { action: "delete", domain }` — success `{ ok: true, domain,
  deleted: true }`; refusals `{ code: "cert_in_use", domain, usedBy: [names],
  references: [{ file: <basename>, line }] }`, `{ code: "cert_not_found" }`,
  `{ code: "cert_not_managed" }` when no ownership-manifest entry exists, and
  `{ code: "delete_failed" }`. Same rules as `DELETE /api/ssl/:domain`.
- `hub:manageDomain { action: "delete", name, deleteCert? }` — removes the
  domain record and nginx config. When `deleteCert` is `true` and SSL was
  enabled, a successful certificate removal is included as `certDeleted:
  true`. If the certificate is still referenced, is not managed by Easy DevOps,
  or cannot be removed safely, the domain deletion still succeeds and the
  result carries `certDeleted: false`, `certRetained: true`, `certReason`
  (`cert_in_use` | `cert_not_managed` | `delete_failed`), `certMessage`,
  `usedBy`, and `references: [{ file: <basename>, line }]`. The full successful
  result is `{ ok: true, action: "delete", domain, certDeleted, ...retention }`.
- `hub:manageDomain { action: "create" | "update" }` — the dashboard's field
  checks, then `{ code: "cert_missing", certPath, keyPath, hint }` when SSL is
  on and either file is missing (blank paths resolve to `<sslDir>/<name>/`),
  the same refusal as the dashboard's `422 cert_missing`. `update` ignores
  `configFile`, `enabled` and `createdAt` from the payload.
  Creating a domain with custom locations, changing the stored text or clearing
  it requires the additional local grant `nginx.config.edit`. An update can
  omit the text or send its current value with only `domains.edit`. Hub updates
  are partial. When `nginx.config.view` did not expose `ssl.certPath`,
  `ssl.keyPath`, `configFile`, or `advanced.customLocations`, the Hub UI must
  omit those fields rather than submit local defaults such as an empty string.

| Command | Payload | Permission |
|---|---|---|
| `hub:reloadNginx` | — | `nginx.reload` |
| `hub:nginxAction` | `{ action: start \| stop \| restart \| reload \| test }` | `nginx.<action>` |
| `hub:manageDomain` | `{ action: create \| update \| toggle \| delete \| reload, … }`; delete also accepts `deleteCert?: boolean` | `domains.create`, `domains.edit`, `domains.toggle`, `domains.delete` or `nginx.reload` respectively. Raw custom-location changes also require `nginx.config.edit`. |
| `hub:manageSSL` | `{ action: renew \| renewAll \| issue \| delete, … }` | `ssl.<action>` |
| `hub:manageSSL` | `{ action: suggest, domain }` | none (read-only) |
| `hub:manageProcess` | `{ action: start \| stop \| restart, name }` | `process.<action>` |
| `hub:getConfigs` | `{ filename? }` | `nginx.config.view` |
| `hub:saveConfig` | `{ filename, content, reload? }` | `nginx.config.edit` |
| `hub:getLogs` | `{ lines? }` | `nginx.logs.view` |

**`hub:saveConfig`** writes the file inside the nginx config directory, runs
`nginx -t`, and **restores the previous bytes when the test fails** (a new file
is deleted instead), so a rejected config never takes effect.

Its optional `reload: true` is gated **separately**, on `nginx.reload`, because
saving a file that passes `nginx -t` and affecting live traffic are different
things to be trusted with:

- granted → nginx is reloaded after the successful test
- not granted → the file is still saved and tested, **not** reloaded, and the
  result says why. The Hub does not refuse the command: the save itself is
  permitted, and a server that allows editing but not reloading has said
  something specific that a flag must not override.
- only a real boolean `true` asks for a reload — `"true"`, `1` and anything
  else are ignored, since a reload affects live traffic and must never happen
  through a loose coercion.

`data` on success:

```json
{
  "filename": "site.conf",
  "output": "nginx: configuration file … test is successful",
  "reloadRequested": true,
  "reloaded": false,
  "reloadDetail": "Permission 'nginx.reload' is disabled on this server."
}
```

A reload that is attempted and fails does not undo the save — the file has
already passed `nginx -t`, so `reloaded` is `false` and `reloadDetail` explains
that the config is saved and valid but the reload did not succeed.

**`hub:manageProcess`** starts, stops or restarts a PM2 app **by name**. It
refuses when PM2 is not installed, when no process has that name, or when the
app belongs to a different OS user than the one running Easy DevOps (PM2 keeps
a separate process list per user, so that app is not controllable from here).
`start` on an existing app restarts it, matching PM2. `data` echoes
`{ name, action, managed, output }`, where `managed` says whether Easy DevOps
created the app.

### 3.5 Events the agent sends to the Hub

The other direction of the same outbound socket (`core/hub/agent.js`). These
are **not** dashboard events: no browser can send or receive them, and they are
listed because their shapes are a promise the Hub relies on. Every one is sent
only while the socket is connected; when a push is due and the socket is down,
the push is skipped and the next reconnect re-sends the full state.

| Event | Payload | Sent |
|---|---|---|
| `server:info` | `{ platform, sslDir }` — `sslDir` is populated only when `nginx.config.view` is granted and is otherwise `""` | Immediately after a successful handshake and whenever the permission revision changes. Re-sending the empty value replaces a path retained by the Hub after access is revoked |
| `nginx:status` | `{ running, version }` (`version` may be `null`) | Every 5 s, and on connect |
| `server:resources` | `{ cpu, ram, disk }` — whole percentages | Every 30 s, and on connect |
| `domain:health` | `[{ name, enabled, up }]` — `up` is `true`/`false`, or `null` for a disabled domain and for an external backend | Every 60 s, and on connect; reuses the monitors' fresh sweep and probes directly only when there is none |
| `domain:configs` | An explicit Hub projection of every stored domain. It always carries monitoring and ordinary editable fields such as `name`, `enabled`, `port`, `backendHost`, `upstreamType`, `www`, `wildcard`, `behindCloudflare`, safe nested SSL/performance/security values, `advanced.accessLog`, and notification routing. `backendHost` is `null` when a legacy stored value contains URL credentials. `certStatus` (`valid` \| `expiring` \| `expired` \| `not_issued` \| `unreadable`) and `certLabel` may also be present. With `nginx.config.view`, it additionally carries `ssl.certPath`, `ssl.keyPath`, `configFile`, and `advanced.customLocations`. It never carries certificate contents, credentials, or unknown stored fields | On connect, every 5 min, after a pairing/permission revision moves, and after any Hub domain command |
| `channels:list` | `[{ id, name, type }]` — no webhook URL or bot token | On connect and every 5 min |
| `cert:expiry` | `[{ domain, expiresAt, daysLeft, status?, label? }]` — `expiresAt` is an ISO string or `null`, `daysLeft` may be negative, and `status`/`label` use the same values as `domain:configs` | On connect and every 12 h, and after any Hub SSL command |
| `service:state` | `{ installed, running, status, mechanism, mode, startsAt, stoppedByUser, jobsRunningHere, enabledOnBoot, dev, pm2Installed, pm2Version, uptimeMs }`; `installed` is `boolean \| null`, where `null` means protected service files could not be inspected | On connect, every 5 min, and whenever the shared revision moves. It describes the **native** service; `pm2*` is the user's own PM2, a different thing |
| `processes:list` | `{ daemonRunning, apps }` — the same app objects as `GET /api/processes`, and `daemonRunning: false` with `apps: []` when PM2 is absent or its daemon is down | On connect and every 60 s. It never starts a PM2 daemon just to report |
| `deploy:apps` | The **public** app array: `envKeys` (sorted names, never values) instead of `env`, and no credentials. Every `lastRun` is an explicit operational projection. `error`, `reason`, `warnings`, and `logTail` are null/empty unless `deploy.logs` is granted. See §6 | On connect, every 20 s, when any deployment begins or ends, and when a permission revision changes so a revocation takes effect promptly |
| `deploy:progress` | `{ appId, runId, status, steps: [{ name, status }], stage, skippedStages: string[], lines: string[], skipped?, done, at }`. `steps` comes from the run record's `step` field; `stage` (2.17.0) is the canonical stage the run is in, or `null` when the record has none; `skippedStages` (2.17.0) is the record's own `skippedStages`, or `[]` when it has none. `at` is an ISO string. `lines` is empty unless `deploy.logs` is granted. See §6 | Every second while a run is active, and once with `done: true` when it ends (status no longer running or its lock is released) |
| `permissions:state` | `{ tree, permissions, comingSoon }` — the catalog plus this server's grant map | On connect and whenever permissions change |
| `nginx:configs` | `[{ name, content }]` | After a `hub:getConfigs` command, in addition to its `command:result` |
| `nginx:logs` | `{ lines }` — the error log, without the REST response's `file` echo | After a `hub:getLogs` command, in addition to its `command:result` |
| `command:result` | `{ requestId, ok, error, data }` | Exactly once for every command in §3.4, and also passed to the socket.io acknowledgement when the Hub supplied one |
| `command:progress` | `{ requestId, step, status, detail?, domain?, at }` — `status` is `running`, `ok`, `failed` or `skipped`; `step` is the stage or run step name (kebab ids such as `nginx-reload`, or lower-case words separated by single spaces such as `waiting for validation`, at most 40 characters in total); `domain` is optional and names the domain an SSL stage belongs to; `detail` is at most 300 characters and never contains a secret or file contents; `at` is an ISO string | While a command runs, at most 5 events per second per `requestId`; beyond that the extra events are dropped except the last of each step. Emitted by `hub:manageDeploy { action: "linkDomain" }` (with or without a certificate) and, since 2.16.0, by `hub:manageSSL { action: "issue" \| "renew" \| "renewAll" }` |

**Live command progress.** `command:progress` fills the silence between a long
command's dispatch and its single `command:result`. Steps are reported
`running` and then `ok`, `failed` or `skipped`.

SSL issue, renew and renewAll use the nine stages from §3.1, in order:

`preflight` → `account and order` → `challenge ready` →
`waiting for validation` → `certificate received` → `files written` →
`nginx config test` → `nginx reload` → `https verified`.

`renewAll` reports each domain in turn; frames are correlated by the command's
`requestId`, and `domain` says which name a stage belongs to. `waiting for
validation` is re-sent with the elapsed time, and `https verified` is `skipped`
as `served by Cloudflare's edge` when preflight found a Cloudflare address.

`domain` (2.17.0) is optional on every frame. SSL `issue`, `renew` and
`renewAll` set it on every frame they emit; other commands may omit it. It is a
hostname of at most 253 characters, optionally with a leading `*.` wildcard
label. A malformed `domain` drops the whole frame — an unattributable stage is
worse than a missing one — while an absent `domain` is allowed. The Hub relays a
valid frame unchanged as `server:<serverId>:commandProgress`.

For a `linkDomain` that issues a certificate the steps are `domain` →
`preflight` → `account and order` → `challenge ready` →
`waiting for validation` → `certificate received` → `files written` →
`https` (switch the domain record to the new certificate paths) →
`nginx config test` → `nginx reload` → `https verified`. A link that reuses an
existing certificate omits the issuer stages and reports `https: running` →
`ok`; a link with SSL off reports `https: skipped` and still reports the three
nginx/verification stages (the last as `skipped`). `domain` remains first, and
the nginx stages come after `https` because the config being tested and
reloaded must reference the issued certificate.

The Hub validates the frame, relays it to the browser as
`server:<serverId>:commandProgress` with the same payload, and stores nothing.
It relays only while the command is still pending for that server, so an
unknown, completed or another server's `requestId` is dropped. The stored
result behind `command:result` (and
`GET /servers/:id/commands/:requestId`) remains the outcome; progress is never
the source of truth.

Each command also writes one timing line to the agent's log — command name,
duration and `ok`/`error`, never its arguments or any payload value (those can
hold environment values, config contents and deploy tokens):

```text
[hubAgent] hub:getConfigs 34ms ok
```

That line is how a first-run delay (cold import, certificate scan) is told
apart from a Hub-side timeout.

Payloads deliberately mirror the REST shape where one exists (`nginx:status` ↔
`GET /api/nginx/status`, `processes:list` ↔ `GET /api/processes`). Three are
narrower than their REST counterpart: `cert:expiry` carries only
`{ domain, expiresAt, daysLeft }` rather than the full certificate objects,
`deploy:apps` is the public app view, and `channels:list` has names and types
only. No payload ever contains the dashboard password or its hash, a
notification channel's credentials, a deploy token, an app's environment
**values**, or the shared pairing secret.

`local:changed` (§3.1) is **not** one of these: it is published by the agent on
the local job bus after a Hub command, never sent to the Hub.

---

## 4. Non-API routes

Everything outside `/api` (and `/socket.io`) is public by design: a shell has
to load before a session can exist. It contains no privileged data — it calls
`GET /api/auth` and then renders the login, first-run or dashboard view.

Two UI builds can be served at `/`. **The React app in `dist/ui` is the
default;** the classic EJS page is a temporary fallback, selected only when
asked for.

| Path | Auth | Serves |
|---|---|---|
| `/js/*`, `/css/*`, `/img/*` | public | Classic static assets (`src/dashboard/public`, directory indexes disabled) |
| `/assets/*` | public | The React build's assets from `dist/ui`. Only a content-hashed name is cached as immutable; anything else is `no-cache` |
| `GET /` and any other GET/HEAD path | public | The active UI's `index.html` |

**Choosing the UI.** With no choice made, the React build is served. The
`dashboardUi` setting (§2.5) selects `new` or `classic` and is what a
background service reads on each boot; a stored `classic` from before the
default changed is migrated to `new` once. `--classic-ui` selects the old EJS
page **for that run and wins over the setting** — it is the one-run way back to
the fallback and needs no restart. `--new-ui` is still accepted and does
nothing; it prints a note saying the React UI is the default. The setting takes
effect on restart; `--classic-ui` does not need one.

**New UI serving.** When the new UI is active, `GET /` and any other GET or
HEAD path that is not a static file or a registered API route return
`dist/ui/index.html` with `Cache-Control: no-cache` — the SPA fallback. The
cache policy follows the file, not the directory: an asset whose name carries a
Vite content hash (such as `assets/index-4f3a9c2b.js`) is
`public, max-age=31536000, immutable`, and everything else in the build —
`index.html`, a favicon copied into `assets/` — is `no-cache`, so a rebuilt
bundle is picked up on the next page load instead of being served from cache
for a year. `/api` and `/socket.io` are mounted exactly as before and are
unaffected; every API endpoint keeps the auth and transport rules of §1.
Socket.io clients are unaffected.

**Missing build.** If the new UI is the default but `dist/ui/index.html` does
not exist, the server prints the expected path and `npm run build:ui`, and
serves the classic UI for that run instead of failing to start. If the build
disappears while the dashboard is running, the same fallback answers rather than
Express's default error page. `<dist>/ui` can be pointed elsewhere with
`EASY_DEVOPS_UI_DIST`, which is how the UI tests use a fixture.

---

## 5. The deploy hook listener (not part of the dashboard)

Added in 2.4.0. `core/deploy/hookServer.js` — a separate HTTP listener that a
CI job calls. It is **off by default**, runs with the background jobs (so it is
there when the dashboard is not), and none of the dashboard's rules in §1
apply to it: there is no session, no `X-EZ-Request` header and no cookie. It
authenticates each request with the app's deploy token instead.

It answers three requests and nothing else. (They are listed as prose, not as a
table, on purpose: the route check in `e2e/run.mjs` reads this document's
tables as dashboard routes, and these are not.)

- **Start a deployment** — a `POST` to the path `/.ez-deploy/<app>`, with the
  header `Authorization: Bearer <deploy token>`.
- **Read a run's status** — a `GET` of `/.ez-deploy/<app>/runs/<runId>`, with
  the same header.
- **Liveness** — a `GET` of `/.ez-deploy/health`, no token: `{ "ok": true }`.
  It says nothing about apps.

Details:

- The start request's body is optional JSON `{ "ref": "<commit, tag or branch>" }` (16 kB
  limit). `202` `{ runId, status: "running", statusPath }`; `409`
  `{ error, runId }` when that app is already deploying.
- The status answer is `{ runId, status, step, sha, error, rolledBackTo,
  startedAt, finishedAt }`. No log: the log can contain build output and stays
  behind the dashboard login.
- `401` `{ "error": "Unauthorized" }` for a wrong token, an app with no token
  and an app that does not exist — deliberately indistinguishable.
- `429` after 10 failed attempts from one client in 15 minutes.
- A token can only start a deployment of **its** app from that app's configured
  repository. It cannot choose the repository, the commands or the
  environment.

---

## 6. Deployments through the Hub (agent events and commands)

Added in 2.5.0. What `core/hub/agent.js` exchanges with the Hub about
deployments. The local permission check in `core/hubPermissions.js` is the
gate for every command; the Hub's own copy is a UI hint.

**Telemetry the agent sends** — `deploy:apps`: the array `GET /api/deployments`
returns in `apps`, with two differences that matter. Each app is the *public*
view: `envKeys` (sorted variable names) instead of `env`, and no credentials.
Its `settings` is the same one the dashboard sees, including `steps` and
`runtime` (2.15.0). Each `lastRun` is also rebuilt from an explicit operational
allowlist (`id`, app/release identifiers, trigger, ref, SHA, status, step,
stage, skipped stages, timestamps, and rollback outcome). `error`, `reason`,
`warnings`, and `logTail` remain null/empty unless `deploy.logs` is granted;
unknown future fields are not forwarded. Sent on connect, every 20 seconds,
when any deployment begins or ends, and when a permission revision changes —
whether the deployment was started from the Hub, the local dashboard, the CLI
or CI. Operational monitoring is not gated: a paired server remains a monitored
server.

**Live progress** — `deploy:progress`: sent at most once per second for a run
that is under way, and once with `done: true` when it ends (its status is no
longer `running`, or its app's deploy lock is released). The agent finds the
run from the same per-app lock, run record and run log the engine writes, so a
deployment started in another process is visible too. `status` and
`steps: [{ name, status }]` come from the run record's real `step` and `status`
fields. `stage` (2.17.0) and `skippedStages` (2.17.0) come from the record's own
`stage` and `skippedStages`, so the Hub can draw the same stage bar as the
dashboard: `stage` is the canonical stage the run is in (`null` when the record
has none) and `skippedStages` is the stages this run does not perform (`[]` when
the record has none). Old agents send neither; a reader then falls back to
`steps` and shows no skipped stages. `lines` carries the newest log lines only, and is present only while
`deploy.logs` is granted at send time — otherwise it is `[]`. One event carries
at most 200 lines and 32 KiB; each line is capped at 2000 characters, and when
more arrived the newest are kept with `skipped` counting the rest. Every line
is redacted with the app's own environment values and token before it leaves;
any line matching `/PRIVATE KEY-----/` is dropped entirely. The Hub relays the
event to the browser as `server:<serverId>:deployProgress` and stores nothing:
the stored run fetched with `hub:manageDeploy { action: 'run' }` is still the
source of truth for a finished deployment.

**The command `hub:manageDeploy`** — payload `{ action, id?, … }`, answered
with `command:result` like every other command.

- `list` → `{ apps }` · `detail` (`id`) → the app with `runs` and `releases` ·
  `github` (`id`) → the setup of §2.8, with the public app view. No permission.
  Every `lastRun` and run in `runs` uses the same explicit projection as
  `deploy:apps`. Operational status metadata is always present. `error`,
  `reason`, `warnings`, and `logTail` are null/empty unless `deploy.logs` is
  granted.
- `deploy` (`id`, `ref?`) → `{ runId, status: "running" }`. Needs `deploy.run`.
- `rollback` (`id`, `releaseId?`) → `{ runId, status }`. Needs `deploy.rollback`.
- `deleteRelease` (`id`, `releaseId`) → `{ deleted }` (2.8.0). Needs
  `deploy.manage`. Refused for the live release, the one an automatic rollback
  would return to, and while a deployment of the app is running.
- `run` (`id`, `runId`) → the projected run with `log` (last 32 KiB),
  `logTruncated`, and `logUnavailable: "legacy-format"` when the record predates
  per-run redaction (2.18.0). Needs `deploy.logs`, which the agent checks before
  the core handler receives the command. New-format logs go through the same
  treatment as live progress: environment values and the app's token are
  redacted, and PEM private-key blocks are dropped, before they leave the
  server. Legacy-format logs are withheld because a secret rotated since they
  were written cannot be redacted from them safely.
- `linkDomain` (`id`, `domain`, `www?`, `ssl?`, `redirect?`,
  `behindCloudflare?`) · `unlinkDomain` (`id`) · `move` (`id`, `path`)
  (2.6.0, extended 2.12.0). Need `deploy.manage`; `linkDomain` additionally
  needs `domains.create`, and with `ssl.mode: "issue"` (or legacy
  `ssl: true`) also `ssl.issue`. Its payload and result are those of
  `PUT /api/deployments/:id/domain` above. A link that issues a certificate is
  a long command — `202 { dispatched, command, requestId, status: "pending" }`
  plus the stored result, exactly like `hub:manageSSL { action: "issue" }` —
  and is listed that way in the Hub's command-delivery table. While it runs it
  emits `command:progress` with the stages in §3.5: `domain`, then the
  certificate stages `preflight` → `account and order` → `challenge ready` →
  `waiting for validation` → `certificate received` → `files written`, then
  `https`, `nginx config test`, `nginx reload` and `https verified`. It never
  carries certificate paths from the caller.
  `delete` with `deleteDomain: true` additionally needs `domains.delete`.
- `create` (`app`) · `update` (`id`, `app`) · `delete` (`id`, `deleteDomain?`,
  `purgeData?`) · `issueToken` (`id`) → `{ token, tokenHint }`. Need
  `deploy.manage`. Without `purgeData` the persistent data is kept, and the
  answer carries `sharedKept` and `sharedPath`. `app` takes the fields of
  `POST /api/deployments` **except `env`**, which is ignored here; it may also
  carry `generateKey`, with the same default and result as `POST
  /api/deployments` (the app is created without starting a deployment). Its
  `settings` is passed through unchanged, including `steps` and `runtime`
  (2.15.0), and validated by the same core functions as the dashboard.
- `regenerateKey` (`id`) · `testKey` (`id`) · `addKeyToGithub` (`id`, `token?`)
  (2.13.0). Need `deploy.manage`. They are the Hub forms of
  `POST /api/deployments/:id/deploy-key`, `…/deploy-key/test` and
  `…/deploy-key/github` above, with the same results; `addKeyToGithub` falls
  back to the app's own token when its `authType` is `token`. The token passes
  through once like an environment value and is not stored by the Hub. All
  three are quick commands; `testKey` is bounded at 12 seconds by the agent, inside the Hub's 15-second quick-command window.
- `getEnv` (`id`) → `{ env }` · `setEnv` (`id`, `env`) → `{ envKeys }`. Need
  `deploy.env`. This is the only path on which environment values leave the
  server, and only to the person who asked; the Hub does not store them.

**The command `hub:deployHook`** — sent only by the Hub's CI endpoint (on the
Hub, the path `/api/v1/hooks/deploy/<serverId>/<appId>`, called with POST),
never by a Hub user. Needs `deploy.ci`. Payload `{ action: "trigger" | "status", appId,
token, ref?, runId? }`, where `token` is whatever the CI job presented. **The
server verifies it** against the app's own deploy token, exactly as §5 does;
the Hub stores no token and cannot mint one.

- An unknown app, an app without a token and a wrong token all answer
  `{ unauthorized: true }` and nothing else.
- `trigger` → `{ started: true, runId }`, or
  `{ started: false, status: 409, error, runId }` when the app is already
  deploying.
- `status` → `{ found: true, run: { runId, appId, trigger, ref, sha,
  releaseId, status, step, stage, skippedStages, startedAt, finishedAt, error,
  warnings, rolledBackTo, reason, logTail, rollbackSucceeded } }`, or
  `{ found: false }`. The run uses the same explicit Hub projection as every
  other deployment surface. `error`, `warnings`, `reason`, and `logTail`
  remain null/empty unless `deploy.logs` is granted. A trigger refusal's
  `error` is likewise null without that grant.

The Hub's CI endpoint answers these with the same non-5xx failures as a command:
an offline agent is `409 AGENT_OFFLINE`, an agent that does not answer is
`424 AGENT_TIMEOUT`, and an agent refusal is `422 AGENT_ERROR` carrying its own
message. The body keeps `error` and adds `code`; Cloudflare may replace an
origin 5xx page, so a real status could lose the reason.

The Hub's endpoint answers a CI job in the same shape as §5, so one workflow
file works against either; only the `EZ_DEPLOY_URL` secret differs.
