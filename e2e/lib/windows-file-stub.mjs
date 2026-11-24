// Route native process calls into a suite's existing command ledger. The text
// representation is for assertions only. No executable is launched here.
import path from 'node:path';

export function aclCall(args) {
  return 'icacls ' + args.map((arg, index) => index === 0 || !arg.startsWith('/') ? `"${arg}"` : arg).join(' ');
}

export function withFileStub(options) {
  const { run } = options;
  return { ...options, approvedDataDir: options.dataDir, runFile: async (file, args) => {
    const exe = path.win32.basename(file).toLowerCase();
    if (exe === 'powershell.exe') return { success: true, stdout: '', stderr: '' };
    if (!run) throw new Error(`Missing test runner for ${exe}`);
    if (exe === 'icacls.exe') return run(aclCall(args));
    if (exe === 'sc.exe') return run(`${exe} ${args[0]} ${args[1]} "${args[2]}"`);
    return run(`& "${file}" ${args.join(' ')}`);
  } };
}
