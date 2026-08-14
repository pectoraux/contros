/**
 * Schedule Engine Tests — CPM correctness.
 *
 * Run: bun test tests/unit/schedule.test.ts
 */
import { test, expect, describe } from 'bun:test'
import { computeSchedule, generateProgrammeFromEstimate, type ScheduleActivity } from '../../src/lib/engines/schedule-engine'

describe('CPM scheduling', () => {
  test('single activity with no deps', () => {
    const result = computeSchedule([
      { id: 'a1', name: 'Activity 1', duration: 5, predecessors: [] },
    ])
    expect(result.projectDuration).toBe(5)
    expect(result.activities[0].earlyStart).toBe(0)
    expect(result.activities[0].earlyFinish).toBe(5)
    expect(result.activities[0].totalFloat).toBe(0)
    expect(result.activities[0].isCritical).toBe(true)
    expect(result.criticalPath).toContain('a1')
  })

  test('two sequential FS activities', () => {
    const result = computeSchedule([
      { id: 'a1', name: 'A', duration: 3, predecessors: [] },
      { id: 'a2', name: 'B', duration: 4, predecessors: [{ id: 'a1', type: 'FS', lag: 0 }] },
    ])
    expect(result.projectDuration).toBe(7)
    expect(result.activities[1].earlyStart).toBe(3)
    expect(result.activities[1].earlyFinish).toBe(7)
    expect(result.criticalPath).toEqual(['a1', 'a2'])
  })

  test('parallel activities → shorter path is non-critical', () => {
    const result = computeSchedule([
      { id: 'a1', name: 'A', duration: 5, predecessors: [] },
      { id: 'a2', name: 'B', duration: 2, predecessors: [] },
      { id: 'a3', name: 'C', duration: 3, predecessors: [{ id: 'a1', type: 'FS', lag: 0 }, { id: 'a2', type: 'FS', lag: 0 }] },
    ])
    expect(result.projectDuration).toBe(8) // a1(5) + a3(3)
    const a2 = result.activities.find((a) => a.id === 'a2')!
    expect(a2.totalFloat).toBe(3) // a1 finishes at 5, a2 at 2, so float = 3
    expect(a2.isCritical).toBe(false)
    const a1 = result.activities.find((a) => a.id === 'a1')!
    expect(a1.isCritical).toBe(true)
  })

  test('FS with lag', () => {
    const result = computeSchedule([
      { id: 'a1', name: 'A', duration: 3, predecessors: [] },
      { id: 'a2', name: 'B', duration: 2, predecessors: [{ id: 'a1', type: 'FS', lag: 2 }] },
    ])
    expect(result.activities[1].earlyStart).toBe(5) // 3 + 2 lag
    expect(result.projectDuration).toBe(7)
  })

  test('empty activities → 0 duration', () => {
    const result = computeSchedule([])
    expect(result.projectDuration).toBe(0)
    expect(result.activities).toEqual([])
    expect(result.criticalPath).toEqual([])
  })

  test('cycle is handled defensively (no infinite loop)', () => {
    const result = computeSchedule([
      { id: 'a1', name: 'A', duration: 3, predecessors: [{ id: 'a2', type: 'FS', lag: 0 }] },
      { id: 'a2', name: 'B', duration: 3, predecessors: [{ id: 'a1', type: 'FS', lag: 0 }] },
    ])
    // Should not hang; should return some result
    expect(result).toBeDefined()
    expect(result.activities.length).toBe(2)
  })
})

describe('generateProgrammeFromEstimate', () => {
  test('generates activities from estimate lines', () => {
    const activities = generateProgrammeFromEstimate({
      estimateLines: [
        { id: 'l1', description: 'Blockwork', quantity: 240, workDefinition: { name: 'Blockwork', productivityRule: 12 } },
        { id: 'l2', description: 'Plastering', quantity: 150, workDefinition: { name: 'Plastering', productivityRule: 15 } },
      ],
      startDate: '2025-01-01',
      crewsPerActivity: 2,
    })
    expect(activities.length).toBe(2)
    // 240 / (12 * 2) = 10 days
    expect(activities[0].duration).toBe(10)
    // 150 / (15 * 2) = 5 days
    expect(activities[1].duration).toBe(5)
    // Linked FS in sequence
    expect(activities[1].predecessors[0].id).toBe('l1')
  })

  test('missing productivity → min 1 day', () => {
    const activities = generateProgrammeFromEstimate({
      estimateLines: [
        { id: 'l1', description: 'Unknown', quantity: 100, workDefinition: null },
      ],
      startDate: '2025-01-01',
    })
    expect(activities[0].duration).toBeGreaterThanOrEqual(1)
  })
})
