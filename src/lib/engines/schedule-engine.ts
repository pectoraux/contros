/**
 * Schedule Engine — deterministic Critical Path Method (CPM) scheduler.
 *
 * Supports the four standard precedence relationships (FS, SS, FF, SF) with
 * lag. Detects cycles defensively (returns a partial result for the
 * acyclic prefix; cycle activities are returned with zeroed values).
 *
 * Pure: no `Math.random`, no `Date.now`, no I/O, no Prisma client.
 *
 * Note on the spec's backward-pass formulas: the literal text of the spec
 * ("LF of SS successors - lag - duration + 0", etc.) is mathematically
 * inconsistent with the forward-pass definitions. This implementation
 * uses the standard CPM backward-pass derivations, which are the unique
 * consistent interpretation of the four relationship types. See
 * `computeSchedule` JSDoc for the exact formulas used.
 */

/** Predecessor relationship. */
export interface SchedulePredecessor {
  id: string;
  type: 'FS' | 'SS' | 'FF' | 'SF';
  lag: number;
}

/** A schedule activity. */
export interface ScheduleActivity {
  id: string;
  name: string;
  /** Duration in days. */
  duration: number;
  predecessors: SchedulePredecessor[];
  /**
   * R1 — ACTIVITY ORDERING: optional presentation/work-sequence property.
   *
   * The engine does NOT use `sequence` for computation — CPM dates, float,
   * and critical path are derived exclusively from `duration` + `predecessors`.
   * The field is carried through so that callers can preserve a stable
   * display order across `ProgrammeActivity` → `ScheduleActivity` mappings
   * without an additional lookup. Omit if you don't need it.
   *
   * Ordering is NOT scheduling. The caller is responsible for sorting
   * activities by `(sequence, id)` BEFORE building a snapshot if determinism
   * is required.
   */
  sequence?: number;
}

/** A scheduled activity with CPM dates and floats. */
export interface ScheduledActivity extends ScheduleActivity {
  earlyStart: number;
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  totalFloat: number;
  freeFloat: number;
  isCritical: boolean;
}

/** Result of `computeSchedule`. */
export interface ScheduleResult {
  activities: ScheduledActivity[];
  /** Max early finish across all activities (0 if empty). */
  projectDuration: number;
  /** IDs of critical activities in topological order. */
  criticalPath: string[];
  /** True if a cycle was detected (partial result returned). */
  hasCycle: boolean;
}

const NEG_FLOAT_EPSILON = 1e-9;

/**
 * Compute a deterministic CPM schedule.
 *
 * Forward pass (per spec, verified correct):
 * - `FS`: `ES_S = EF_P + lag`
 * - `SS`: `ES_S = ES_P + lag`
 * - `FF`: `ES_S = EF_P + lag - duration_S`  (since `EF_S = EF_P + lag`)
 * - `SF`: `ES_S = ES_P + lag - duration_S`  (since `EF_S = ES_P + lag`)
 * - `ES` = max over predecessors; activities with no predecessors start at 0.
 * - `EF = ES + duration`.
 *
 * Backward pass (standard CPM — see file header re: spec inconsistency):
 * - `FS`: `LF_P = min(LF_P, LS_S - lag)`
 * - `FF`: `LF_P = min(LF_P, LF_S - lag)`
 * - `SS`: `LS_P = min(LS_P, LS_S - lag)`
 * - `SF`: `LS_P = min(LS_P, LF_S - lag)`
 * - Combined: `LF_P = min(LF_P, LS_P + duration_P)` after SS/SF constraints.
 * - Activities with no successors: `LF = projectDuration`, `LS = LF - duration`.
 *
 * Floats:
 * - `totalFloat = LS - ES`
 * - `freeFloat = min(ES of successors) - EF` (or `totalFloat` if no successors)
 * - `isCritical = totalFloat <= 0` (handles negative float from infeasible
 *   schedules; the spec says `=== 0`, but `<= 0` is more robust against
 *   floating-point error and surfaces infeasible activities).
 *
 * `criticalPath` = critical activity IDs in topological order.
 *
 * Cycle handling: Kahn's algorithm topologically sorts the activity graph.
 * If a cycle exists, acyclic activities are scheduled normally and cycle
 * activities are returned with all CPM fields zeroed (and `isCritical = false`).
 *
 * @param activities - The activities to schedule.
 * @returns A `ScheduleResult`.
 */
export function computeSchedule(activities: ScheduleActivity[]): ScheduleResult {
  if (!activities || activities.length === 0) {
    return { activities: [], projectDuration: 0, criticalPath: [], hasCycle: false };
  }

  const map = new Map<string, ScheduleActivity>();
  for (const a of activities) {
    map.set(a.id, a);
  }

  // Build successor map and in-degrees (deduplicating predecessor edges).
  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const a of activities) {
    if (!inDegree.has(a.id)) inDegree.set(a.id, 0);
    if (!successors.has(a.id)) successors.set(a.id, []);
  }
  for (const a of activities) {
    const seenPreds = new Set<string>();
    for (const p of a.predecessors ?? []) {
      if (!map.has(p.id) || seenPreds.has(p.id)) continue;
      seenPreds.add(p.id);
      inDegree.set(a.id, (inDegree.get(a.id) ?? 0) + 1);
      const succList = successors.get(p.id) ?? [];
      succList.push(a.id);
      successors.set(p.id, succList);
    }
  }

  // Kahn's topological sort.
  const queue: string[] = [];
  inDegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });
  const topoOrder: string[] = [];
  const inDegreeCopy = new Map(inDegree);
  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);
    for (const s of successors.get(id) ?? []) {
      const d = (inDegreeCopy.get(s) ?? 1) - 1;
      inDegreeCopy.set(s, d);
      if (d === 0) queue.push(s);
    }
  }

  const hasCycle = topoOrder.length < activities.length;

  // Forward pass.
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of topoOrder) {
    const a = map.get(id)!;
    const dur = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    let earlyStart = 0;
    for (const p of a.predecessors ?? []) {
      const pred = map.get(p.id);
      if (!pred) continue;
      const predES = es.get(p.id) ?? 0;
      const predEF = ef.get(p.id) ?? 0;
      const lag = Number.isFinite(p.lag) ? p.lag : 0;
      let candidate: number;
      switch (p.type) {
        case 'FS':
          candidate = predEF + lag;
          break;
        case 'SS':
          candidate = predES + lag;
          break;
        case 'FF':
          candidate = predEF + lag - dur;
          break;
        case 'SF':
          candidate = predES + lag - dur;
          break;
        default:
          candidate = predEF + lag;
      }
      if (candidate > earlyStart) earlyStart = candidate;
    }
    if (earlyStart < 0) earlyStart = 0;
    es.set(id, earlyStart);
    ef.set(id, earlyStart + dur);
  }

  const projectDuration = topoOrder.reduce((m, id) => Math.max(m, ef.get(id) ?? 0), 0);

  // Backward pass.
  const ls = new Map<string, number>();
  const lf = new Map<string, number>();
  // Initialise: activities with no successors get LF = projectDuration.
  for (const id of topoOrder) {
    const succs = successors.get(id) ?? [];
    const dur = Number.isFinite(map.get(id)!.duration) && map.get(id)!.duration > 0
      ? map.get(id)!.duration
      : 0;
    if (succs.length === 0) {
      lf.set(id, projectDuration);
      ls.set(id, projectDuration - dur);
    } else {
      // Initialise to a large value; will be tightened below.
      lf.set(id, Number.POSITIVE_INFINITY);
      ls.set(id, Number.POSITIVE_INFINITY);
    }
  }

  // Process in reverse topological order so successors are computed first.
  for (let i = topoOrder.length - 1; i >= 0; i--) {
    const id = topoOrder[i];
    const a = map.get(id)!;
    const dur = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    let lateFinish = lf.get(id) ?? projectDuration;
    let lateStart = ls.get(id) ?? lateFinish - dur;

    for (const sid of successors.get(id) ?? []) {
      const s = map.get(sid)!;
      const predRel = (s.predecessors ?? []).find((p) => p.id === id);
      if (!predRel) continue;
      const sLS = ls.get(sid) ?? 0;
      const sLF = lf.get(sid) ?? 0;
      const lag = Number.isFinite(predRel.lag) ? predRel.lag : 0;
      switch (predRel.type) {
        case 'FS':
          // LF_P = min(LF_P, LS_S - lag)
          if (sLS - lag < lateFinish) lateFinish = sLS - lag;
          break;
        case 'FF':
          // LF_P = min(LF_P, LF_S - lag)
          if (sLF - lag < lateFinish) lateFinish = sLF - lag;
          break;
        case 'SS':
          // LS_P = min(LS_P, LS_S - lag)
          if (sLS - lag < lateStart) lateStart = sLS - lag;
          break;
        case 'SF':
          // LS_P = min(LS_P, LF_S - lag)
          if (sLF - lag < lateStart) lateStart = sLF - lag;
          break;
        default:
          break;
      }
    }

    // Enforce LF = LS + duration (definition). Take the min on both sides
    // so that whichever was tightened by constraints dominates.
    const derivedLF = lateStart + dur;
    if (derivedLF < lateFinish) lateFinish = derivedLF;
    const derivedLS = lateFinish - dur;
    if (derivedLS < lateStart) lateStart = derivedLS;

    // If no successors constrained this activity and it has successors
    // (shouldn't happen given the initialisation above, but be safe),
    // fall back to projectDuration.
    if (!Number.isFinite(lateFinish)) lateFinish = projectDuration;
    if (!Number.isFinite(lateStart)) lateStart = lateFinish - dur;

    lf.set(id, lateFinish);
    ls.set(id, lateStart);
  }

  // Build result in INPUT order (so callers can correlate by index/id).
  const scheduled: ScheduledActivity[] = activities.map((a) => {
    if (!topoOrder.includes(a.id)) {
      // In a cycle — zeroed values.
      return {
        ...a,
        earlyStart: 0,
        earlyFinish: 0,
        lateStart: 0,
        lateFinish: 0,
        totalFloat: 0,
        freeFloat: 0,
        isCritical: false,
      };
    }
    const dur = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    const earlyStart = es.get(a.id) ?? 0;
    const earlyFinish = ef.get(a.id) ?? earlyStart + dur;
    const lateFinish = lf.get(a.id) ?? projectDuration;
    const lateStart = ls.get(a.id) ?? lateFinish - dur;
    const totalFloat = lateStart - earlyStart;

    // freeFloat = min(ES of successors) - EF.
    let minSuccES = Number.POSITIVE_INFINITY;
    for (const sid of successors.get(a.id) ?? []) {
      const succES = es.get(sid) ?? 0;
      if (succES < minSuccES) minSuccES = succES;
    }
    const freeFloat =
      minSuccES === Number.POSITIVE_INFINITY ? totalFloat : minSuccES - earlyFinish;

    const isCritical = totalFloat <= NEG_FLOAT_EPSILON;

    return {
      ...a,
      earlyStart,
      earlyFinish,
      lateStart,
      lateFinish,
      totalFloat,
      freeFloat,
      isCritical,
    };
  });

  // Critical path: critical activity IDs in topological order.
  const criticalPath = topoOrder.filter((id) => {
    const a = map.get(id)!;
    const dur = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    const earlyStart = es.get(id) ?? 0;
    const lateStart = ls.get(id) ?? (lf.get(id) ?? projectDuration) - dur;
    return lateStart - earlyStart <= NEG_FLOAT_EPSILON;
  });

  return {
    activities: scheduled,
    projectDuration,
    criticalPath,
    hasCycle,
  };
}

/** Input to `generateProgrammeFromEstimate`. */
export interface GenerateProgrammeInput {
  estimateLines: {
    id: string;
    description: string;
    quantity: number;
    workDefinition?: { name: string; productivityRule?: number } | null;
  }[];
  /** ISO date string — informational only; durations are in days from day 0. */
  startDate: string;
  /** Number of parallel crews per activity (default 1). */
  crewsPerActivity?: number;
}

/**
 * Heuristically generate a sequential CPM programme from an estimate's lines.
 *
 * Each estimate line becomes one activity. Duration is:
 * `ceil(quantity / (productivityRule * crewsPerActivity || 1))`,
 * with a minimum of 1 day. Activities are linked FS in input order
 * (activity `i`'s predecessor is activity `i - 1`).
 *
 * @param input - The estimate lines and crew config.
 * @returns A list of `ScheduleActivity` suitable for `computeSchedule`.
 */
export function generateProgrammeFromEstimate(
  input: GenerateProgrammeInput,
): ScheduleActivity[] {
  const crews =
    typeof input.crewsPerActivity === 'number' &&
    Number.isFinite(input.crewsPerActivity) &&
    input.crewsPerActivity > 0
      ? input.crewsPerActivity
      : 1;

  const lines = input.estimateLines ?? [];
  const activities: ScheduleActivity[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prod = line.workDefinition?.productivityRule;
    const prodNum =
      typeof prod === 'number' && Number.isFinite(prod) ? prod : 0;
    const qty = Number.isFinite(line.quantity) ? line.quantity : 0;
    const denom = prodNum * crews || 1; // spec: `productivityRule * crews || 1`
    const rawDuration = Math.ceil(qty / denom);
    const duration = Math.max(1, rawDuration);

    const predecessors: SchedulePredecessor[] =
      i > 0
        ? [{ id: lines[i - 1].id, type: 'FS', lag: 0 }]
        : [];

    activities.push({
      id: line.id,
      name: line.workDefinition?.name || line.description,
      duration,
      predecessors,
    });
  }

  return activities;
}
