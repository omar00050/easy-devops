/**
 * core/platform.js
 *
 * Shared platform constants and nginx command-building helpers.
 * Used by CLI managers, dashboard routes, and dashboard lib.
 * Centralises the isWindows guard and nginx shell invocations so they
 * are defined exactly once and behave identically everywhere.
 */

export const isWindows = process.platform === 'win32';

/**
 * Returns the nginx binary invocation string suitable for use in shell commands.
 * On Windows returns `& "path\nginx.exe"` (PowerShell call operator + quoted path).
 * On Linux/macOS returns the plain `nginx` command (assumed to be on PATH).
 * @param {string} nginxDir
 * @returns {string}
 */
export function getNginxExe(nginxDir) {
  if (isWindows) {
    return `& "${nginxDir}\\nginx.exe"`;
  }
  return 'nginx';
}

/**
 * Builds the nginx config-test command for the given nginx directory.
 * On Windows passes an explicit -c flag with the full conf path to avoid
 * working-directory issues when nginx.exe is invoked from an arbitrary cwd.
 * @param {string} nginxDir
 * @returns {string}
 */
export function nginxTestCmd(nginxDir) {
  if (isWindows) {
    const confPath = `${nginxDir}\\conf\\nginx.conf`;
    return `& "${nginxDir}\\nginx.exe" -c "${confPath}" -t`;
  }
  return 'nginx -t';
}

/**
 * Builds the nginx graceful-reload command.
 * @param {string} nginxDir
 * @returns {string}
 */
export function nginxReloadCmd(nginxDir) {
  if (isWindows) {
    return `& "${nginxDir}\\nginx.exe" -s reload`;
  }
  return 'nginx -s reload';
}

/**
 * Merges stdout and stderr from a shell result into a single trimmed string.
 * Useful for surfacing nginx output that may come from either stream.
 * @param {{ stdout: string, stderr: string }} result
 * @returns {string}
 */
export function combineOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}
