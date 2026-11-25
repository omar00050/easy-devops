/**
 * Bounds one user-visible service operation stage.
 *
 * Uninstall used to have one unbounded spinner. A large runtime or a slow ACL
 * operation could leave it there indefinitely. Each stage now has its own
 * deadline and error, while the operation receives that deadline so child
 * processes and filesystem copies can stop cooperatively.
 */

export const UNINSTALL_STAGE_TIMEOUT_MS = 5 * 60_000;
const ABORT_SETTLE_GRACE_MS = 250;

function describeLimit(timeoutMs) {
  if (timeoutMs < 60_000) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = timeoutMs / 60_000;
  const shown = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
  return `${shown} minute${minutes === 1 ? '' : 's'}`;
}

export class StageTimeoutError extends Error {
  constructor(stage, timeoutMs) {
    super(`the "${stage}" stage exceeded its ${describeLimit(timeoutMs)} limit`);
    this.name = 'StageTimeoutError';
    this.code = 'EZ_STAGE_TIMEOUT';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

/** Milliseconds available before a deadline. Throws once it has expired. */
export function remainingStageMs(
  deadline,
  stage = 'operation',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
) {
  if (!Number.isFinite(deadline)) return Infinity;
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new StageTimeoutError(stage, timeoutMs);
  return remaining;
}

/**
 * Run one named stage and reject when its deadline expires.
 *
 * The action receives the deadline and an AbortSignal. Operations that can
 * block, such as streamed file copies, must use both. For subprocess work, pass
 * `remainingStageMs(deadline)` as the child timeout.
 */
export async function runUninstallStage({
  stage,
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  log = () => {},
  action,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Uninstall stage timeout must be a positive number');
  }

  log(`${stage} (limit ${describeLimit(timeoutMs)})…`);

  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new StageTimeoutError(stage, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  let result;
  let actionOutcome = null;
  const actionPromise = Promise.resolve().then(() => action({
    deadline,
    signal: controller.signal,
    timeoutMs,
  })).then(
    (value) => {
      actionOutcome = { ok: true, value };
      return value;
    },
    (error) => {
      actionOutcome = { ok: false, error };
      throw error;
    },
  );
  // The race below observes this promise. Keep a rejection handler attached so
  // a slow action cannot become an unhandled rejection after the deadline.
  actionPromise.catch(() => {});
  try {
    result = await Promise.race([actionPromise, timeout]);
  } catch (error) {
    if (error?.code === 'EZ_STAGE_TIMEOUT') {
      // Give cooperative cleanup a brief chance to restore markers or remove a
      // staging directory. The caller still receives the timeout if cleanup
      // cannot settle promptly, rather than waiting forever.
      if (!actionOutcome) {
        await Promise.race([
          actionPromise.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, ABORT_SETTLE_GRACE_MS)),
        ]);
      }
      throw error;
    }
    if (controller.signal.aborted && controller.signal.reason?.code === 'EZ_STAGE_TIMEOUT') {
      throw controller.signal.reason;
    }
    const wrapped = new Error(`${stage} failed: ${error?.message ?? String(error)}`, { cause: error });
    wrapped.code = 'EZ_STAGE_FAILED';
    wrapped.stage = stage;
    wrapped.timeoutMs = timeoutMs;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  log(`  ${stage}: complete`);
  return result;
}
