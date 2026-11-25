/**
 * core/permissions.js
 *
 * The ONLY source of the sudo rules Easy DevOps installs on Linux, and of the
 * one-time terminal commands that install them.
 *
 * ── Why this file is small and strict ──────────────────────────────────────
 *
 * A NOPASSWD sudoers rule is a standing grant of root to whoever runs as this
 * user — including anything that compromises the dashboard. Earlier versions
 * granted bare `/usr/bin/systemctl`, the unrestricted nginx binary, `mkdir`,
 * `chown`, `cp`, `chmod`, `tee` and `certbot`. Each of those is a root shell on
 * its own: `tee /etc/sudoers`, `chown $USER /etc/shadow`, `nginx -c <file>`,
 * `systemctl link <unit>`. The dashboard also used to RECEIVE the operator's
 * sudo password in an HTTP request to install them.
 *
 * Now:
 *   - the rules are exactly the five commands Easy DevOps runs with `sudo -n`,
 *     byte for byte, and nothing else (see SUDO_COMMANDS);
 *   - nothing here ever accepts, stores or forwards a password. The setup is a
 *     short script the operator runs in their own terminal, where sudo asks for
 *     their password itself. The dashboard only shows that script.
 *   - directories that used to need `sudo mkdir` / `sudo chown` at runtime are
 *     created and handed to the operator ONCE, by that same script, so no
 *     standing grant is needed for them.
 *
 * ── Matching is literal ────────────────────────────────────────────────────
 *
 * sudo compares the command line exactly. Every call site must invoke these
 * strings verbatim (`sudo -n /usr/bin/systemctl reload nginx`), which is why
 * they live in one exported list: a caller that builds its own string is a
 * caller whose `sudo -n` fails silently. No wildcards are used anywhere — a
 * `*` in a sudoers rule matches spaces too, so `chown user /srv/*` also matches
 * `chown user /srv/x /etc/shadow`.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';

import { run, runInteractiveFile } from './shell.js';
import { isWindows } from './platform.js';
import { loadConfig } from './config.js';

/** Where the rule file is installed. */
export const SUDOERS_PATH = '/etc/sudoers.d/easy-devops';

/**
 * The only two Linux directories the generated setup may hand to the operator.
 * They are constants, not values derived from settings: a stored-path writer
 * must not be able to turn the operator's one privileged setup step into a
 * chown of an arbitrary directory.
 */
export const LINUX_NGINX_DIR = '/etc/nginx';
export const LINUX_NGINX_CONF_DIR = '/etc/nginx/conf.d';
export const LINUX_SSL_DIR = '/etc/easy-devops/ssl';
export const MANAGED_LINUX_DIRS = Object.freeze([
  LINUX_SSL_DIR,
  LINUX_NGINX_CONF_DIR,
]);

/**
 * Root-side directory preparation, passed to a fixed `/bin/sh` with the target
 * and owner as separate positional arguments.
 *
 * It check-then-creates every existing component, rejects links, and requires
 * every non-final component to be root-owned. The user therefore cannot swap a
 * component for a link between the generated setup text and the privileged
 * command. Missing components are created one at a time with plain `mkdir`
 * after proving their parent is root-owned.
 */
export const MANAGED_DIR_SETUP_SCRIPT = String.raw`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
target=$1
owner=$2
if [ "$target" != /etc/easy-devops/ssl ] && [ "$target" != /etc/nginx/conf.d ]; then
  echo "Refusing an unmanaged directory: $target" >&2
  exit 64
fi
owner_uid=$(/usr/bin/id -u "$owner")
parent=__EASY_DEVOPS_TARGET_PARENT__
top=__EASY_DEVOPS_TOP__
for current in "$top" "$parent" "$target"; do
  if [ -L "$current" ]; then
    echo "Refusing linked directory component: $current" >&2
    exit 65
  fi
  if [ -e "$current" ]; then
    if [ ! -d "$current" ]; then
      echo "Refusing non-directory component: $current" >&2
      exit 66
    fi
    uid=$(/usr/bin/stat -c %u -- "$current")
    if [ "$current" = "$target" ]; then
      if [ "$uid" -ne 0 ] && [ "$uid" -ne "$owner_uid" ]; then
        echo "Refusing foreign target ownership: $current" >&2
        exit 67
      fi
    elif [ "$uid" -ne 0 ]; then
      echo "Refusing user-owned ancestor: $current" >&2
      exit 68
    fi
  else
    ancestor=__EASY_DEVOPS_CURRENT_PARENT__
    if [ "$(/usr/bin/stat -c %u -- "$ancestor")" -ne 0 ]; then
      echo "Refusing to create under a non-root directory: $ancestor" >&2
      exit 69
    fi
    /bin/mkdir -m 0755 -- "$current"
  fi
done
# -h is essential: if the final path is replaced between the checks above and
# this call, GNU chown must never follow a resulting symlink. The second check
# then reports failure instead of treating that race as a successful handover.
/bin/chown -h -- "$owner" "$target"
if [ -L "$target" ] || [ ! -d "$target" ]; then
  echo "Refusing a target that stopped being an unlinked directory: $target" >&2
  exit 70
fi`
  .replace('__EASY_DEVOPS_TARGET_PARENT__', '${target%/*}')
  .replace('__EASY_DEVOPS_TOP__', '${parent%/*}')
  .replace('__EASY_DEVOPS_CURRENT_PARENT__', '${current%/*}');

/**
 * Every command Easy DevOps runs non-interactively with `sudo -n`.
 *
 * Adding a line here is a security decision: it grants root to that exact
 * command for the operator's account, permanently. Do not add a binary
 * without its full argument list, and never add a shell, an editor, a file
 * writer (`tee`, `cp`, `install`), an ownership or mode changer, or a service
 * manager without a fixed unit.
 */
export const SUDO_COMMANDS = Object.freeze([
  '/usr/bin/systemctl start nginx',
  '/usr/bin/systemctl stop nginx',
  '/usr/bin/systemctl reload nginx',
  '/usr/bin/systemctl restart nginx',
  '/usr/bin/systemctl status nginx',
]);

/**
 * The prefix a call site uses to run one of SUDO_COMMANDS.
 *
 * @param {string} command One entry of SUDO_COMMANDS
 * @returns {string} e.g. `sudo -n /usr/bin/systemctl reload nginx`
 */
export function sudoCommand(command) {
  if (!SUDO_COMMANDS.includes(command)) {
    // Refusing loudly is the point: an unlisted command would fail under
    // `sudo -n` anyway, but silently, at the worst moment.
    throw new Error(`"${command}" is not a granted sudo command; add it to SUDO_COMMANDS deliberately`);
  }
  return `sudo -n ${command}`;
}

/**
 * Whether a name is safe to write into a sudoers line and a shell command.
 *
 * Deliberately narrower than what Linux allows: lowercase POSIX-portable
 * names only. A name outside this set is refused rather than escaped, because
 * the sudoers grammar and the shell have different quoting rules and getting
 * either wrong is a privilege escalation.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeUserName(name) {
  return typeof name === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(name);
}

/**
 * Whether a directory path is safe to put in the setup script.
 *
 * Absolute, normalised, and made only of characters that need no quoting.
 * `/` itself and the system roots are refused: handing one of those to the
 * operator would be the very ownership grant this file exists to avoid.
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function isSafeSetupDir(dir) {
  if (typeof dir !== 'string' || !dir.startsWith('/')) return false;
  if (path.posix.normalize(dir) !== dir || dir.endsWith('/')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(dir)) return false;
  if (dir.split('/').includes('..')) return false;

  // Top-level directories are never handed over: at least two segments, so
  // `/etc/ssl/easy-devops` is possible and `/srv` is not.
  if (dir.split('/').filter(Boolean).length < 2) return false;

  // Directories whose ownership is itself a root grant. `/etc/ssl` holds the
  // system CA trust store; `/etc/nginx` holds nginx.conf, whose main context
  // can `load_module` and set the worker `user` — only `/etc/nginx/conf.d`
  // (included inside `http {}`) is safe to give away.
  const forbidden = new Set([
    '/etc/sudoers.d', '/etc/systemd', '/etc/ssl', '/etc/ssl/certs', '/etc/ssl/private',
    '/etc/pki', '/etc/nginx', '/etc/letsencrypt', '/etc/cron.d', '/etc/init.d', '/etc/pam.d',
    '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/local', '/usr/local/bin', '/usr/share',
    '/var/lib', '/var/log', '/var/spool', '/var/www',
  ]);
  if (forbidden.has(dir)) return false;

  // A path that merely looks harmless is not enough: settings are editable, so
  // accepting an arbitrary descendant would let a stored-path writer ask the
  // operator to chown `/etc/ssl/private/anything` or an unrelated existing
  // `/opt/nginx/conf.d`. Only the reviewed Easy DevOps roots are authorized.
  return MANAGED_LINUX_DIRS.includes(dir);
}

function managedDirKind(dir) {
  if (dir === LINUX_SSL_DIR) return 'ssl';
  if (dir === LINUX_NGINX_CONF_DIR) return 'nginx';
  return null;
}

/**
 * Check every existing component without following links.
 *
 * This is exported for the regression suite: the suite runs on Windows too,
 * where POSIX `/etc` paths cannot be created, so the stat/realpath functions
 * and uid are injectable. Production always uses the host filesystem.
 */
export function validateManagedPath(dir, kind, deps = {}) {
  if (!isSafeSetupDir(dir) || managedDirKind(dir) !== kind) {
    return 'not a dedicated Easy DevOps or nginx configuration directory';
  }

  if (!deps.validateFilesystem) return null;

  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  if (!Number.isInteger(uid)) return 'could not determine the account that will receive the directory';

  const lstat = deps.lstatSync ?? fs.lstatSync;
  const realpath = deps.realpathSync ?? fs.realpathSync;
  const pieces = dir.split('/').filter(Boolean);
  let current = '';
  let missing = false;

  for (const piece of pieces) {
    current += `/${piece}`;
    if (missing) continue;

    let stat;
    try {
      stat = lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        missing = true;
        continue;
      }
      return `could not inspect ${current}: ${error.message}`;
    }

    if (stat.isSymbolicLink?.()) return `${current} is a link`;
    const isFinal = current === dir;
    if (!isFinal && !stat.isDirectory?.()) return `${current} is not a directory`;
    if (isFinal && !stat.isDirectory?.()) return `${current} is not a directory`;
    if (stat.uid !== 0 && stat.uid !== uid) {
      return `${current} is owned by uid ${stat.uid}, not root or the installing account`;
    }
    if ((Number(stat.mode) & 0o022) !== 0) {
      return `${current} is writable by a group or other users`;
    }
    try {
      const resolved = realpath(current);
      if (path.posix.normalize(resolved) !== current) {
        return `${current} resolves to ${resolved}`;
      }
    } catch (error) {
      return `could not resolve ${current}: ${error.message}`;
    }
  }

  return null;
}

function validateNginxAnchor(nginxDir, deps) {
  const lstat = deps.lstatSync ?? fs.lstatSync;
  const conf = path.posix.join(nginxDir, 'nginx.conf');
  let stat;
  try {
    stat = lstat(conf);
  } catch (error) {
    return `could not find the nginx configuration at ${conf}`;
  }
  if (stat.isSymbolicLink?.() || !stat.isFile?.()) return `${conf} must be an unlinked regular file`;
  // The installing account may write conf.d. It must never write nginx.conf:
  // the main context can load modules and choose the worker account, so that
  // file plus the granted reload command would itself be a root escalation.
  if (stat.uid !== 0) return `${conf} is owned by uid ${stat.uid}, not root`;
  if ((Number(stat.mode) & 0o022) !== 0) return `${conf} is writable by a group or other users`;
  return null;
}

/**
 * The directories Easy DevOps writes to at runtime on Linux.
 *
 * These are the ones that used to be created with `sudo mkdir` and handed over
 * with `sudo chown` on every issuance. Instead they are created ONCE by the
 * setup script, so no standing grant is needed for them:
 *
 *   - the configured sslDir, where certificates and the ACME account key live
 *   - nginx's conf.d, where the per-domain configs are written
 *
 * There is deliberately no HTML webroot in this list: HTTP-01 challenges are
 * never written to disk for nginx to serve. They are answered by the loopback
 * listener this process starts and nginx proxies to (see the header of
 * core/ssl-issuer.js and core/acme-challenge.js), so handing a webroot to the
 * operator would grant ownership of a directory nothing uses.
 *
 * Both the dashboard and the CLI call this, so the commands they show and run
 * cannot drift apart. Anything that is not a safe path for the script is
 * returned in `refused` with the reason, rather than silently dropped: the
 * operator has to know that directory will still need root.
 *
 * @param {Object} [config] Defaults to loadConfig()
 * @returns {{ ownDirs: string[], refused: Array<{ dir: string, reason: string }> }}
 */
export function deriveOwnDirs(config = loadConfig(), deps = {}) {
  const nginxDir = typeof config?.nginxDir === 'string' ? config.nginxDir : '';

  const ownDirs = [];
  const refused = [];
  const managed = [
    {
      dir: typeof config?.sslDir === 'string' ? config.sslDir : '',
      reviewed: LINUX_SSL_DIR,
      kind: 'ssl',
    },
    {
      dir: nginxDir ? path.posix.join(nginxDir, 'conf.d') : '',
      reviewed: LINUX_NGINX_CONF_DIR,
      kind: 'nginx',
    },
  ];

  for (const { dir, reviewed, kind } of managed) {
    if (!dir) continue;
    if (dir !== reviewed) {
      refused.push({
        dir,
        reason: `not the reviewed managed directory ${reviewed}`,
      });
      continue;
    }

    const validateFilesystem = deps.validateFilesystem ?? (process.platform === 'linux');
    const reason = validateManagedPath(dir, kind, {
      validateFilesystem,
      lstatSync: deps.lstatSync,
      realpathSync: deps.realpathSync,
      uid: deps.uid,
    }) || (validateFilesystem && kind === 'nginx' ? validateNginxAnchor(LINUX_NGINX_DIR, deps) : null);
    if (reason) {
      refused.push({
        dir,
        reason,
      });
      continue;
    }

    if (!ownDirs.includes(dir)) ownDirs.push(dir);
  }

  return { ownDirs, refused };
}

/**
 * The single sudoers line.
 *
 * `(root)` rather than `(ALL)`: these commands only ever run as root, and
 * `(ALL)` would also allow them as any other account for no reason.
 *
 * @param {string} user
 * @returns {string}
 */
export function buildSudoersLine(user) {
  if (!isSafeUserName(user)) {
    throw new Error(`refusing to write a sudoers rule for an unsafe user name: ${JSON.stringify(user)}`);
  }
  return `${user} ALL=(root) NOPASSWD: ${SUDO_COMMANDS.join(', ')}`;
}

/**
 * The exact commands the operator runs once, in their own terminal.
 *
 * Returned as lines so the dashboard can display them and the CLI can run
 * them through `runInteractive`, where sudo prompts on the real terminal.
 * Nothing here is ever given a password.
 *
 * The rule file is validated with `visudo -cf` BEFORE it is installed. A
 * syntax error in /etc/sudoers.d disables sudo for the whole machine, so an
 * unvalidated install could lock the operator out of root entirely.
 *
 * @param {Object} opts
 * @param {string} [opts.user]       Defaults to the current account
 * @param {string[]} [opts.ownDirs]  Directories to create and hand to `user`
 *                                    once (certificate dir, nginx conf.d) so no
 *                                    runtime sudo is needed. deriveOwnDirs()
 *                                    above is the one place they are chosen.
 * @returns {{ ok: true, lines: string[] } | { ok: false, reason: string }}
 */
export function buildSetupScript({ user = os.userInfo().username, ownDirs = [] } = {}) {
  if (!isSafeUserName(user)) {
    return { ok: false, reason: `the account name ${JSON.stringify(user)} cannot be used safely in a sudoers rule` };
  }

  for (const dir of ownDirs) {
    if (!isSafeSetupDir(dir) || !managedDirKind(dir)) {
      return {
        ok: false,
        reason: `refusing to hand ${JSON.stringify(dir)} to ${user}: it is not a dedicated Easy DevOps or nginx configuration directory`,
      };
    }
  }

  // ONE chained line, through a `mktemp` file. A fixed name in /tmp would be a
  // privilege escalation: another local account could replace the file between
  // `visudo -cf` validating it and `sudo install` copying it, and have ITS
  // content installed as root's sudoers. `mktemp` gives a random name created
  // 0600 by the operator, and /tmp's sticky bit stops anyone else deleting or
  // replacing it. Chaining with && means a failed validation installs nothing,
  // and the file is removed either way.
  const lines = [
    `t="$(mktemp)" && printf '%s\\n' '${buildSudoersLine(user)}' > "$t" && sudo visudo -cf "$t" `
      + `&& sudo install -o root -g root -m 0440 "$t" ${SUDOERS_PATH}; rc=$?; rm -f "$t"; test $rc -eq 0`,
  ];

  for (const dir of ownDirs) {
    lines.push(
      `sudo /bin/sh -c '${MANAGED_DIR_SETUP_SCRIPT}' easy-devops-managed-dir ${dir} ${user}`,
    );
  }

  return { ok: true, lines };
}

/**
 * Whether the rule is installed and works.
 *
 * `systemctl status` exits non-zero for an inactive unit even when sudo let
 * it run, so the signal is whether sudo itself refused (it says "password").
 *
 * @returns {Promise<boolean>}
 */
export async function checkPermissionsConfigured() {
  if (isWindows) return true;
  const result = await run(`${sudoCommand('/usr/bin/systemctl status nginx')} 2>/dev/null`);
  return result.success || !String(result.stderr ?? '').includes('password');
}

/**
 * CLI only: runs the setup script in the operator's terminal.
 *
 * Each line goes through `runInteractive`, so sudo asks for the password on
 * the real TTY. It stops at the first failure — in particular, if
 * `visudo -cf` rejects the file, nothing is installed.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.ownDirs]
 * @returns {Promise<{ success: boolean, reason?: string, failedAt?: string }>}
 */
export async function setupLinuxPermissions({ ownDirs = [] } = {}) {
  if (isWindows) return { success: false, reason: 'sudo rules are a Linux concept; nothing to set up on Windows' };

  const script = buildSetupScript({ ownDirs });
  if (!script.ok) return { success: false, reason: script.reason };

  const user = os.userInfo().username;
  const stage = `set -e; t=$(mktemp); trap 'rm -f "$t"' EXIT; printf '%s\\n' "$1" > "$t"; sudo visudo -cf "$t"; sudo install -o root -g root -m 0440 "$t" "$2"`;
  const commands = [['bash', ['-c', stage, 'easy-devops', buildSudoersLine(user), SUDOERS_PATH]]];
  for (const dir of ownDirs) {
    commands.push([
      'sudo',
      ['/bin/sh', '-c', MANAGED_DIR_SETUP_SCRIPT, 'easy-devops-managed-dir', dir, user],
    ]);
  }
  for (const [index, [file, args]] of commands.entries()) {
    if (!(await runInteractiveFile(file, args)).success) {
      return { success: false, reason: `stopped at: ${script.lines[index]}`, failedAt: script.lines[index] };
    }
  }

  return { success: true };
}
