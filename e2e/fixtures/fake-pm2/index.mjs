/**
 * e2e/fixtures/fake-pm2/index.mjs — a PM2 stand-in for tests.
 *
 * PM2 on Windows is deliberately isolated behind `runner`'s injectable `run`,
 * because the real thing has machine-wide named pipes and a daemon that any
 * pm2 command starts. This fake answers the exact command strings `runner`
 * builds, keeps its app list in a small JSON file (so two callers — the
 * dashboard and the CLI — can be shown reading the same PM2), and records
 * every call so a test can prove that a refused call spawned nothing.
 *
 * It is a fixture, never a suite: `e2e/run.mjs` only runs `*.test.mjs`.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The executable `where.exe pm2` / `command -v pm2` reports. */
export const FAKE_PM2_PATH = process.platform === 'win32'
  ? 'C:\\fake-npm\\pm2.cmd'
  : '/fake-bin/pm2';

/** One `pm2 jlist` entry, in the shape PM2 really prints. */
function makeApp(name, { status = 'online', script = null, username = 'admin' } = {}) {
  const online = status === 'online';
  return {
    name,
    pm_id: null,
    pid: online ? 4242 : 0,
    monit: { cpu: online ? 1 : 0, memory: online ? 1024 * 1024 : 0 },
    pm2_env: {
      status,
      pm_uptime: online ? Date.now() - 60_000 : 0,
      restart_time: 0,
      unstable_restarts: 0,
      exec_mode: 'fork_mode',
      pm_exec_path: script,
      pm_cwd: script ? path.dirname(script) : null,
      username,
      env: {},
    },
  };
}

function ok(stdout = '') {
  return {
    success: true, stdout, stderr: '', exitCode: 0, code: 0,
    truncated: { stdout: 0, stderr: 0 },
  };
}

function fail(stderr = '') {
  return {
    success: false, stdout: '', stderr, exitCode: 1, code: 1,
    truncated: { stdout: 0, stderr: 0 },
  };
}

/**
 * @param {{
 *   stateFile?: string,          // shared JSON app list (omit for in-memory)
 *   apps?: Array<Object|string>, // initial apps: a name or { name, status }
 *   version?: string,
 *   installed?: boolean,         // false makes where.exe find nothing
 *   failJlist?: string|null,     // makes `jlist` fail with this error
 *   username?: string,
 * }} [options]
 * @returns {{
 *   run: (command: string, options?: Object) => Promise<Object>,
 *   calls: string[],
 *   clearCalls: () => void,
 *   apps: () => Array<Object>,
 * }}
 */
export function createFakePm2({
  stateFile = null,
  apps = [],
  version = '6.0.14',
  installed = true,
  failJlist = null,
  username = 'admin',
} = {}) {
  const calls = [];
  let state = null;

  const seed = () => ({
    apps: apps.map((a) => {
      if (typeof a === 'string') return makeApp(a, { username });
      return makeApp(a.name, { status: a.status ?? 'online', username });
    }),
  });

  const persist = () => {
    if (!stateFile) return;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  };

  const load = () => {
    if (stateFile && fs.existsSync(stateFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (parsed && Array.isArray(parsed.apps)) {
          state = parsed;
          return state;
        }
      } catch {
        // A half-written file is replaced by the seed below.
      }
    }
    if (!state) state = seed();
    persist();
    return state;
  };

  const find = (name) => load().apps.find((a) => a.name === name) ?? null;

  const upsert = (name, script) => {
    const current = load();
    const existing = current.apps.find((a) => a.name === name);
    if (existing) {
      existing.pm2_env.status = 'online';
      existing.pid = 4242;
      existing.pm2_env.pm_exec_path = script ?? existing.pm2_env.pm_exec_path;
      existing.pm2_env.pm_uptime = Date.now();
      persist();
      return;
    }
    const app = makeApp(name, { username, script });
    current.apps.push(app);
    persist();
  };

  const quoted = (command, verb) => {
    const match = command.match(new RegExp(`\\b${verb}\\s+(?:"([^"]+)"|(\\S+))`));
    return match ? (match[1] ?? match[2]) : null;
  };

  const nameOption = (command) => {
    const match = command.match(/--name\s+(?:"([^"]+)"|(\S+))/);
    return match ? (match[1] ?? match[2]) : null;
  };

  const appNameFromConfig = (file) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const first = Array.isArray(parsed?.apps) ? parsed.apps[0] : null;
      if (first?.name) return String(first.name);
    } catch {
      // Not a readable config: fall back to its filename.
    }
    return path.basename(file).replace(/\.json$/i, '');
  };

  async function run(command) {
    const cmd = String(command ?? '');
    calls.push(cmd);

    if (/^(where\.exe pm2|command -v pm2)$/i.test(cmd.trim())) {
      return installed ? ok(`${FAKE_PM2_PATH}\n`) : fail('INFO: Could not find files for the given pattern(s).');
    }

    if (!installed) return fail('PM2 is not installed.');

    if (/\s--version$/i.test(cmd)) return ok(`${version}\n`);

    if (/\sjlist$/i.test(cmd)) {
      if (failJlist) return fail(failJlist);
      return ok(JSON.stringify(load().apps));
    }

    if (/\ssave$/i.test(cmd)) return ok('[PM2] Saving current process list...\n');

    if (/\sstartup$/i.test(cmd)) {
      return ok(`sudo env PATH=$PATH pm2 startup systemd -u ${username} --hp /home/${username}\n`);
    }
    if (/\sunstartup$/i.test(cmd)) {
      return ok(`sudo env PATH=$PATH pm2 unstartup systemd -u ${username} --hp /home/${username}\n`);
    }

    if (/\slogs\s+/i.test(cmd)) {
      const name = quoted(cmd, 'logs');
      return ok(`[${name}] hello from the fake PM2 log\n`);
    }

    // `reload <file> --update-env` belongs to a config file; `reload <name>`
    // is the plain app action below.
    if (/\sreload\s+.+\s--update-env$/i.test(cmd)) {
      const file = quoted(cmd, 'reload');
      if (file && /\.json$/i.test(file)) upsert(appNameFromConfig(file), file);
      return ok('[PM2] Applied successfully\n');
    }

    if (/\sstart\s+/i.test(cmd)) {
      const target = quoted(cmd, 'start');
      const name = nameOption(cmd)
        ?? (target && /\.json$/i.test(target) ? appNameFromConfig(target) : path.basename(target ?? 'app'));
      upsert(name, target);
      return ok(`[PM2] Starting ${name}\n`);
    }

    const action = cmd.match(/\s(stop|restart|reload|delete)\s+(?:"([^"]+)"|(\S+))\s*$/);
    if (action) {
      const verb = action[1];
      const name = action[2] ?? action[3];
      const app = find(name);
      if (!app) return fail(`[PM2][ERROR] Process or Namespace ${name} not found`);

      if (verb === 'delete') {
        state.apps = state.apps.filter((a) => a.name !== name);
      } else if (verb === 'stop') {
        app.pm2_env.status = 'stopped';
        app.pid = 0;
      } else {
        app.pm2_env.status = 'online';
        app.pid = 4242;
        app.pm2_env.restart_time = (app.pm2_env.restart_time ?? 0) + 1;
        app.pm2_env.pm_uptime = Date.now();
      }
      persist();
      return ok(`[PM2] ${verb} ${name}\n`);
    }

    if (/^npm install -g pm2$/i.test(cmd.trim())) return ok(`+ pm2@${version}\n`);

    return fail(`fake pm2: unknown command: ${cmd}`);
  }

  return {
    run,
    calls,
    clearCalls() { calls.length = 0; },
    apps: () => load().apps,
  };
}
