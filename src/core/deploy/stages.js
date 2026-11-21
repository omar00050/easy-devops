/**
 * core/deploy/stages.js
 *
 * The canonical stage bar of one deployment run.
 *
 * A run record's `step` is precise but not uniform: the reserved steps are
 * named ids, while a custom step is "step N", which says nothing about where
 * the run is on the bar. `stage` is the canonical answer — one of RUN_STAGES,
 * or `done` — so the dashboard and the Hub can draw the same bar without
 * parsing `step`.
 *
 * `skippedStages` is the other half: which stages this run will not perform at
 * all. A project with no post hook never reaches `post`, and a project whose
 * build is part of `start` has no `build` stage. Knowing that up front lets a
 * bar show those stages as skipped rather than pending forever.
 *
 * `step` keeps its old meaning; this module only adds to it.
 */

/** The stages a normal run can be in, in order. */
export const RUN_STAGES = Object.freeze([
  'fetch', 'settings', 'pre', 'install', 'build', 'migrate', 'start', 'health', 'post', 'finish',
]);

/** The three stages a custom step can be part of. */
const COMMAND_STAGES = Object.freeze(['install', 'build', 'migrate']);

function commandsPresent(commands) {
  return Array.isArray(commands) && commands.length > 0;
}

/**
 * The stage a run is in when its `step` is `stepId`.
 *
 * A canonical id is its own stage. A custom step (`step N`) has no stage of
 * its own: it continues install/build/migrate when it follows one of those,
 * and counts as `build` otherwise.
 *
 * @param {string} stepId The value a run record's `step` holds
 * @param {string|null} [previousStage] The stage before this step
 * @returns {string}
 */
export function stageForStep(stepId, previousStage = null) {
  if (stepId === 'done') return 'done';
  if (RUN_STAGES.includes(stepId)) return stepId;
  return COMMAND_STAGES.includes(previousStage) ? previousStage : 'build';
}

/**
 * The stages this run will not perform, in RUN_STAGES order.
 *
 * Read from the resolved settings, so it can be recorded as soon as the
 * project's settings are known and before any step runs. A disabled step
 * counts as skipped, and a custom step uses whatever stageForStep gives it.
 *
 * @param {Object|null} settings Resolved project settings (see ezfile.js)
 * @returns {string[]}
 */
export function plannedSkippedStages(settings = {}) {
  const skipped = new Set();
  if (!commandsPresent(settings?.pre)) skipped.add('pre');
  if (!commandsPresent(settings?.post)) skipped.add('post');

  const steps = Array.isArray(settings?.steps) ? settings.steps : [];
  const reached = new Set();
  let stage = 'pre';

  steps.forEach((step, index) => {
    if (!step || step.enabled === false) return;
    const stepId = step.kind === 'custom' ? `step ${index + 1}` : step.kind;
    stage = stageForStep(stepId, stage);
    if (COMMAND_STAGES.includes(stage)) reached.add(stage);
  });

  for (const commandStage of COMMAND_STAGES) {
    if (!reached.has(commandStage)) skipped.add(commandStage);
  }

  return RUN_STAGES.filter((stageId) => skipped.has(stageId));
}
