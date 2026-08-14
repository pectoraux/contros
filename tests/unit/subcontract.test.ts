/**
 * Subcontract Reconciliation Tests — P0-7 scope-atom correctness.
 *
 * Run: bun test tests/unit/subcontract.test.ts
 */
import { test, expect, describe } from 'bun:test'
import { reconcileSubcontract, type ReconcileSubcontractInput } from '../../src/lib/engines/subcontract-reconciliation'

const ATOMS = [
  { id: 'a1', name: 'manufacture' },
  { id: 'a2', name: 'delivery' },
  { id: 'a3', name: 'installation' },
  { id: 'a4', name: 'sealant' },
  { id: 'a5', name: 'scaffolding' },
  { id: 'a6', name: 'finishing' },
  { id: 'a7', name: 'testing' },
]

const REQUIRED_LINES = [
  { id: 'l1', description: 'Aluminium windows 1000m²', sellPrice: 50000 },
]

describe('P0-7: structured scope-atom reconciliation', () => {
  test('no quote → blocker, 0% coverage', () => {
    const result = reconcileSubcontract({ requiredLines: REQUIRED_LINES, scopeAtoms: ATOMS, quote: null })
    expect(result.status).toBe('blocker')
    expect(result.coveragePct).toBe(0)
    expect(result.coverageBasis).toBe('none')
  })

  test('lump-sum quote (no scopeCoverages) → blocker, isLumpSum=true', () => {
    const result = reconcileSubcontract({
      requiredLines: REQUIRED_LINES,
      scopeAtoms: ATOMS,
      quote: { id: 'q1', totalAmount: 45000, scopeCoverages: [] },
    })
    expect(result.isLumpSum).toBe(true)
    expect(result.coverageBasis).toBe('lump-sum')
    expect(result.status).toBe('blocker')
    expect(result.coveragePct).toBe(0)
    expect(result.warnings.some((w) => w.includes('lump-sum'))).toBe(true)
  })

  test('full coverage quote → ok, 100%', () => {
    const result = reconcileSubcontract({
      requiredLines: REQUIRED_LINES,
      scopeAtoms: ATOMS,
      quote: {
        id: 'q1',
        totalAmount: 50000,
        scopeCoverages: ATOMS.map((a) => ({ scopeAtomId: a.id, status: 'covered' as const })),
      },
    })
    expect(result.status).toBe('ok')
    expect(result.coveragePct).toBe(1)
    expect(result.coveredAtoms.length).toBe(7)
    expect(result.excludedAtoms.length).toBe(0)
    expect(result.unstatedAtoms.length).toBe(0)
  })

  test('quote with exclusions → blocker', () => {
    const result = reconcileSubcontract({
      requiredLines: REQUIRED_LINES,
      scopeAtoms: ATOMS,
      quote: {
        id: 'q1',
        totalAmount: 40000,
        scopeCoverages: [
          { scopeAtomId: 'a1', status: 'covered' },
          { scopeAtomId: 'a2', status: 'excluded' },
          { scopeAtomId: 'a3', status: 'excluded' },
          { scopeAtomId: 'a4', status: 'excluded' },
          { scopeAtomId: 'a5', status: 'excluded' },
          { scopeAtomId: 'a6', status: 'covered' },
          { scopeAtomId: 'a7', status: 'unstated' },
        ],
      },
    })
    expect(result.status).toBe('blocker')
    expect(result.coveragePct).toBeCloseTo(2 / 7, 2)
    expect(result.excludedAtoms).toContain('delivery')
    expect(result.excludedAtoms).toContain('installation')
    expect(result.unstatedAtoms).toContain('testing')
  })

  test('no scope atoms defined → blocker', () => {
    const result = reconcileSubcontract({
      requiredLines: REQUIRED_LINES,
      scopeAtoms: [],
      quote: { id: 'q1', totalAmount: 50000, scopeCoverages: [] },
    })
    expect(result.status).toBe('blocker')
    expect(result.warnings.some((w) => w.includes('No scope atoms defined'))).toBe(true)
  })

  test('partial coverage (6/7) → warning', () => {
    const result = reconcileSubcontract({
      requiredLines: REQUIRED_LINES,
      scopeAtoms: ATOMS,
      quote: {
        id: 'q1',
        totalAmount: 45000,
        scopeCoverages: [
          { scopeAtomId: 'a1', status: 'covered' },
          { scopeAtomId: 'a2', status: 'covered' },
          { scopeAtomId: 'a3', status: 'covered' },
          { scopeAtomId: 'a4', status: 'covered' },
          { scopeAtomId: 'a5', status: 'covered' },
          { scopeAtomId: 'a6', status: 'covered' },
          { scopeAtomId: 'a7', status: 'unstated' },
        ],
      },
    })
    // 6/7 = 0.857 which is >= 0.8 (not blocker) but < 0.95 (warning)
    expect(result.status).toBe('warning')
    expect(result.coveragePct).toBeCloseTo(6 / 7, 2)
    expect(result.unstatedAtoms.length).toBe(1)
  })

  test('supply-only vs supply-and-install is distinguished', () => {
    // "Supply only" quote: manufacture=covered, delivery=covered, installation=excluded
    const supplyOnly = reconcileSubcontract({
      requiredLines: REQUIRED_LINES,
      scopeAtoms: ATOMS,
      quote: {
        id: 'q1',
        totalAmount: 30000,
        scopeCoverages: [
          { scopeAtomId: 'a1', status: 'covered' },
          { scopeAtomId: 'a2', status: 'covered' },
          { scopeAtomId: 'a3', status: 'excluded' },
          { scopeAtomId: 'a4', status: 'unstated' },
          { scopeAtomId: 'a5', status: 'unstated' },
          { scopeAtomId: 'a6', status: 'unstated' },
          { scopeAtomId: 'a7', status: 'unstated' },
        ],
      },
    })
    expect(supplyOnly.status).toBe('blocker')
    expect(supplyOnly.excludedAtoms).toContain('installation')
    // The old substring matcher would have falsely matched "windows" → covered.
    // The new atom-based matcher correctly identifies installation as excluded.
  })
})
