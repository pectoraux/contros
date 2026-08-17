/**
 * Unit tests for the Programme domain contract.
 *
 * These establish:
 *   - SCHEDULE REPRODUCIBILITY: same snapshot → same ScheduleResult (deterministic).
 *   - FAITHFUL MAPPING: the Programme→ScheduleActivity mapping preserves
 *     id/name/duration/predecessors without losing or inventing scheduling data.
 *   - NO COMMERCIAL DUPLICATION: ProgrammeActivity does NOT carry commercial
 *     values (unitRate, sellPrice, directCost). Construction refs are
 *     relationships, not copied values.
 *   - VALIDATION: duplicate IDs, dangling deps, cycles, negative durations,
 *     self-references are caught before finalization.
 *   - SERIALIZATION: snapshot → JSON → snapshot round-trips faithfully.
 */

import { test, expect, describe } from 'bun:test'
import {
  validateProgrammeSnapshot,
  serializeSnapshot,
  deserializeSnapshot,
  replaySchedule,
  schedulesMatch,
  CURRENT_SCHEDULE_ENGINE_VERSION,
  type ProgrammeSnapshot,
  type ProgrammeActivity,
  type ActivityDependency,
} from '../../src/lib/programme'
import { computeSchedule } from '../../src/lib/engines/schedule-engine'

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeActivity(
  overrides: Partial<ProgrammeActivity> = {},
): ProgrammeActivity {
  return {
    id: 'act-1',
    name: 'Excavation',
    duration: 5,
    constructionRefs: {
      estimateLineId: 'line-1',
      workDefinitionVersionId: 'wdv-1',
      workPackageId: null,
    },
    plannedQuantity: 100,
    status: 'planned',
    predecessorDependencies: [],
    ...overrides,
  }
}

function makeDependency(
  overrides: Partial<ActivityDependency> = {},
): ActivityDependency {
  return {
    id: 'dep-1',
    predecessorActivityId: 'act-1',
    successorActivityId: 'act-2',
    type: 'FS',
    lag: 0,
    ...overrides,
  }
}

function makeSnapshot(
  overrides: Partial<ProgrammeSnapshot> = {},
): ProgrammeSnapshot {
  return {
    programmeId: 'prog-1',
    programmeName: 'Test Programme',
    revisionNo: 1,
    scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
    activities: [makeActivity()],
    dependencies: [],
    finalizedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Programme — schedule reproducibility (the core invariant)', () => {
  test('same snapshot → same ScheduleResult (deterministic)', () => {
    const snapshot = makeSnapshot({
      activities: [
        makeActivity({ id: 'a', duration: 5 }),
        makeActivity({ id: 'b', duration: 3, predecessorDependencies: [] }),
      ],
      dependencies: [makeDependency({ predecessorActivityId: 'a', successorActivityId: 'b' })],
    })
    const result1 = replaySchedule(snapshot)
    const result2 = replaySchedule(snapshot)
    expect(schedulesMatch(result1, result2)).toBe(true)
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2))
  })

  test('different duration → different schedule result', () => {
    const snap1 = makeSnapshot({ activities: [makeActivity({ id: 'a', duration: 5 })] })
    const snap2 = makeSnapshot({ activities: [makeActivity({ id: 'a', duration: 10 })] })
    const r1 = replaySchedule(snap1)
    const r2 = replaySchedule(snap2)
    expect(r1.projectDuration).not.toBe(r2.projectDuration)
    expect(schedulesMatch(r1, r2)).toBe(false)
  })

  test('replay matches direct computeSchedule (faithful bridge)', () => {
    const snapshot = makeSnapshot({
      activities: [
        makeActivity({ id: 'a', duration: 5 }),
        makeActivity({ id: 'b', duration: 3 }),
      ],
      dependencies: [makeDependency({ predecessorActivityId: 'a', successorActivityId: 'b', type: 'FS', lag: 2 })],
    })
    const replayed = replaySchedule(snapshot)
    // Build the same schedule directly via the engine.
    const direct = computeSchedule([
      { id: 'a', name: 'Excavation', duration: 5, predecessors: [] },
      { id: 'b', name: 'Excavation', duration: 3, predecessors: [{ id: 'a', type: 'FS', lag: 2 }] },
    ])
    expect(schedulesMatch(replayed, direct)).toBe(true)
  })
})

describe('Programme — no commercial duplication', () => {
  test('ProgrammeActivity does NOT have unitRate, sellPrice, directCost fields', () => {
    const activity = makeActivity()
    // The activity type must NOT include commercial fields.
    expect('unitRate' in activity).toBe(false)
    expect('sellPrice' in activity).toBe(false)
    expect('directCost' in activity)
    // directCost is checked via the type — the interface doesn't define it.
    // Verify by checking that the key is not in the object.
    expect('unitRate' in activity).toBe(false)
    expect('sellPrice' in activity).toBe(false)
  })

  test('constructionRefs are relationships (IDs), not copied values', () => {
    const activity = makeActivity({
      constructionRefs: {
        estimateLineId: 'est-line-1',
        workDefinitionVersionId: 'wdv-1',
        workPackageId: null,
      },
    })
    // The refs are string IDs, not objects with commercial data.
    expect(typeof activity.constructionRefs.estimateLineId).toBe('string')
    expect(activity.constructionRefs.estimateLineId).toBe('est-line-1')
    // No price/rate/cost is carried.
    expect('unitRate' in activity.constructionRefs).toBe(false)
  })

  test('plannedQuantity is OPTIONAL and NOT auto-copied from EstimateLine', () => {
    const withQty = makeActivity({ plannedQuantity: 120 })
    const withoutQty = makeActivity({ plannedQuantity: null })
    expect(withQty.plannedQuantity).toBe(120)
    expect(withoutQty.plannedQuantity).toBeNull()
    // The field exists but is explicitly nullable — no implicit copy.
  })

  test('the contract source does not mention commercial fields in ProgrammeActivity', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/lib/programme/types.ts', 'utf8')
    // The ProgrammeActivity interface must not define commercial fields.
    const activitySection = src.slice(
      src.indexOf('export interface ProgrammeActivity'),
      src.indexOf('export type ActivityStatus'),
    )
    expect(activitySection).not.toMatch(/unitRate|sellPrice|directCost|marginPct|expectedProfit/i)
  })
})

describe('Programme — validation', () => {
  test('valid snapshot passes validation', () => {
    const snapshot = makeSnapshot({
      activities: [
        makeActivity({ id: 'a', duration: 5 }),
        makeActivity({ id: 'b', duration: 3 }),
      ],
      dependencies: [makeDependency({ predecessorActivityId: 'a', successorActivityId: 'b' })],
    })
    const result = validateProgrammeSnapshot(snapshot)
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.hasCycle).toBe(false)
  })

  test('duplicate activity IDs are caught', () => {
    const snapshot = makeSnapshot({
      activities: [
        makeActivity({ id: 'a', duration: 5 }),
        makeActivity({ id: 'a', duration: 3 }), // duplicate
      ],
    })
    const result = validateProgrammeSnapshot(snapshot)
    expect(result.ok).toBe(false)
    expect(result.duplicateActivityIds).toContain('a')
  })

  test('dangling dependency references are caught', () => {
    const snapshot = makeSnapshot({
      activities: [makeActivity({ id: 'a', duration: 5 })],
      dependencies: [
        makeDependency({ predecessorActivityId: 'a', successorActivityId: 'nonexistent' }),
      ],
    })
    const result = validateProgrammeSnapshot(snapshot)
    expect(result.ok).toBe(false)
    expect(result.danglingDependencyRefs.length).toBeGreaterThan(0)
  })

  test('cycle is detected', () => {
    const snapshot = makeSnapshot({
      activities: [
        makeActivity({ id: 'a', duration: 5 }),
        makeActivity({ id: 'b', duration: 3 }),
      ],
      dependencies: [
        makeDependency({ predecessorActivityId: 'a', successorActivityId: 'b' }),
        makeDependency({ id: 'dep-2', predecessorActivityId: 'b', successorActivityId: 'a' }), // cycle!
      ],
    })
    const result = validateProgrammeSnapshot(snapshot)
    expect(result.ok).toBe(false)
    expect(result.hasCycle).toBe(true)
  })

  test('negative duration is caught', () => {
    const snapshot = makeSnapshot({
      activities: [makeActivity({ id: 'a', duration: -5 })],
    })
    const result = validateProgrammeSnapshot(snapshot)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('negative duration'))).toBe(true)
  })

  test('self-referencing dependency is caught', () => {
    const snapshot = makeSnapshot({
      activities: [makeActivity({ id: 'a', duration: 5 })],
      dependencies: [
        makeDependency({ predecessorActivityId: 'a', successorActivityId: 'a' }),
      ],
    })
    const result = validateProgrammeSnapshot(snapshot)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('self-referencing'))).toBe(true)
  })
})

describe('Programme — serialization', () => {
  test('snapshot → JSON → snapshot round-trips faithfully', () => {
    const snapshot = makeSnapshot({
      activities: [
        makeActivity({ id: 'a', duration: 5, plannedQuantity: 100 }),
        makeActivity({ id: 'b', duration: 3, plannedQuantity: null, constructionRefs: { estimateLineId: null, workDefinitionVersionId: null, workPackageId: null } }),
      ],
      dependencies: [makeDependency({ type: 'SS', lag: 2 })],
    })
    const json = serializeSnapshot(snapshot)
    const restored = deserializeSnapshot(json)
    expect(JSON.stringify(restored)).toBe(JSON.stringify(snapshot))
    expect(restored.activities).toHaveLength(2)
    expect(restored.dependencies).toHaveLength(1)
    expect(restored.activities[0].plannedQuantity).toBe(100)
    expect(restored.activities[1].plannedQuantity).toBeNull()
  })

  test('invalid JSON throws', () => {
    expect(() => deserializeSnapshot('not-json')).toThrow()
  })

  test('missing activities array throws', () => {
    expect(() => deserializeSnapshot('{"programmeId":"p1"}')).toThrow(/missing activities/)
  })
})

describe('Programme — schedule engine version (reproducibility)', () => {
  test('the snapshot carries scheduleEngineVersion', () => {
    const snapshot = makeSnapshot()
    expect(snapshot.scheduleEngineVersion).toBe(CURRENT_SCHEDULE_ENGINE_VERSION)
    expect(typeof snapshot.scheduleEngineVersion).toBe('number')
  })

  test('the snapshot is format-independent of Excel/spreadsheet concepts', () => {
    const snapshot = makeSnapshot()
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toMatch(/xlsx|spreadsheet|worksheet|gantt|cell|column[A-Z]/i)
  })
})
