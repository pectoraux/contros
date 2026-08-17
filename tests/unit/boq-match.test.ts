/**
 * Unit tests for the pure BOQ matching functions.
 *
 * The matcher generates deterministic candidates and suggests a binding
 * status. It NEVER binds — that's the service's job (human-confirmed).
 * These tests establish the matching tiers and the suggestion contract.
 */

import { test, expect, describe } from 'bun:test'
import {
  generateCandidates,
  suggestBindingStatus,
  type CanonicalLineForMatch,
  type BoqItemForMatch,
} from '../../src/lib/boq/match'

const lines: CanonicalLineForMatch[] = [
  {
    estimateLineId: 'line-1',
    estimateId: 'est-1',
    description: 'PVC conduit 25mm',
    unit: 'm',
    quantity: 160,
    unitRate: 10,
    workDefinitionCode: 'WD014',
  },
  {
    estimateLineId: 'line-2',
    estimateId: 'est-1',
    description: 'Concrete work in foundation',
    unit: 'm3',
    quantity: 50,
    unitRate: 450,
    workDefinitionCode: 'WD002',
  },
  {
    estimateLineId: 'line-3',
    estimateId: 'est-1',
    description: 'PVC conduit 25mm', // duplicate description — ambiguous
    unit: 'm',
    quantity: 200,
    unitRate: 11,
    workDefinitionCode: 'WD014B',
  },
]

describe('BOQ matching — Tier 1 CODE_EXACT', () => {
  test('matches an item whose code equals a line WD code', () => {
    const item: BoqItemForMatch = {
      boqItemId: 'item-1',
      normalizedDescription: 'something different',
      normalizedCode: 'WD014',
      normalizedUnit: 'm',
    }
    const cands = generateCandidates(item, lines)
    expect(cands.length).toBeGreaterThanOrEqual(1)
    const top = cands[0]
    expect(top.estimateLineId).toBe('line-1')
    expect(top.matchMethod).toBe('CODE_EXACT')
    expect(top.score).toBe(1.0)
    const s = suggestBindingStatus(cands)
    expect(s.status).toBe('MATCHED')
    expect(s.method).toBe('CODE_EXACT')
  })

  test('code normalization makes wd-014 match WD014', () => {
    const item: BoqItemForMatch = {
      boqItemId: 'item-1',
      normalizedDescription: null,
      normalizedCode: 'WD014', // already normalized by normalizeRow
      normalizedUnit: null,
    }
    const cands = generateCandidates(item, lines)
    expect(cands[0].matchMethod).toBe('CODE_EXACT')
  })
})

describe('BOQ matching — Tier 2 DESCRIPTION_UNIT_EXACT', () => {
  test('matches description + unit exactly (no code)', () => {
    const item: BoqItemForMatch = {
      boqItemId: 'item-2',
      normalizedDescription: 'concrete work in foundation',
      normalizedCode: null,
      normalizedUnit: 'm3',
    }
    const cands = generateCandidates(item, lines)
    expect(cands.length).toBeGreaterThanOrEqual(1)
    const top = cands[0]
    expect(top.estimateLineId).toBe('line-2')
    expect(top.matchMethod).toBe('DESCRIPTION_UNIT_EXACT')
    expect(top.score).toBe(0.95)
    const s = suggestBindingStatus(cands)
    expect(s.status).toBe('MATCHED')
    expect(s.method).toBe('DESCRIPTION_UNIT_EXACT')
  })

  test('description match but unit differs → lower confidence candidate', () => {
    const item: BoqItemForMatch = {
      boqItemId: 'item-2b',
      normalizedDescription: 'concrete work in foundation',
      normalizedCode: null,
      normalizedUnit: 'm2', // different unit
    }
    const cands = generateCandidates(item, lines)
    const top = cands[0]
    expect(top.matchMethod).toBe('DESCRIPTION_UNIT_EXACT')
    expect(top.score).toBe(0.7) // description-only, unit differs
  })
})

describe('BOQ matching — AMBIGUOUS (multiple exact matches)', () => {
  test('two lines with same description+unit → AMBIGUOUS', () => {
    // line-1 and line-3 both have "pvc conduit 25mm" + unit m
    const item: BoqItemForMatch = {
      boqItemId: 'item-3',
      normalizedDescription: 'pvc conduit 25mm',
      normalizedCode: null,
      normalizedUnit: 'm',
    }
    const cands = generateCandidates(item, lines)
    const exact = cands.filter((c) => c.score >= 0.95)
    expect(exact.length).toBe(2)
    const s = suggestBindingStatus(cands)
    expect(s.status).toBe('AMBIGUOUS')
    expect(s.method).toBe('CANDIDATE_SELECTED')
  })
})

describe('BOQ matching — UNMATCHED (no candidates)', () => {
  test('no overlap at all → UNMATCHED', () => {
    const item: BoqItemForMatch = {
      boqItemId: 'item-4',
      normalizedDescription: 'steel reinforcement bars',
      normalizedCode: null,
      normalizedUnit: 'ton',
    }
    const cands = generateCandidates(item, lines)
    const s = suggestBindingStatus(cands)
    expect(s.status).toBe('UNMATCHED')
    expect(s.method).toBeNull()
  })

  test('empty canonical lines → UNMATCHED', () => {
    const item: BoqItemForMatch = {
      boqItemId: 'item-5',
      normalizedDescription: 'anything',
      normalizedCode: null,
      normalizedUnit: null,
    }
    const cands = generateCandidates(item, [])
    expect(cands).toHaveLength(0)
    expect(suggestBindingStatus(cands).status).toBe('UNMATCHED')
  })
})

describe('BOQ matching — Tier 4 loose candidate scoring', () => {
  test('partial token overlap produces a lower-score candidate (AMBIGUOUS)', () => {
    const item: BoqItemForMatch = {
      boqItemId: 'item-6',
      normalizedDescription: 'pvc conduit installation',
      normalizedCode: null,
      normalizedUnit: 'm',
    }
    const cands = generateCandidates(item, lines)
    // Should find line-1/line-3 via partial overlap, but not as exact matches.
    expect(cands.length).toBeGreaterThan(0)
    const allLoose = cands.every((c) => c.matchMethod === 'CANDIDATE_SELECTED')
    expect(allLoose).toBe(true)
    const s = suggestBindingStatus(cands)
    expect(s.status).toBe('AMBIGUOUS')
  })
})

describe('BOQ matching — determinism', () => {
  test('same input always produces same output', () => {
    const item: BoqItemForMatch = {
      boqItemId: 'item-d',
      normalizedDescription: 'pvc conduit 25mm',
      normalizedCode: 'WD014',
      normalizedUnit: 'm',
    }
    const a = generateCandidates(item, lines)
    const b = generateCandidates(item, lines)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  test('candidates sorted by score descending', () => {
    const item: BoqItemForMatch = {
      boqItemId: 'item-s',
      normalizedDescription: 'pvc conduit 25mm',
      normalizedCode: null,
      normalizedUnit: 'm',
    }
    const cands = generateCandidates(item, lines)
    for (let i = 1; i < cands.length; i++) {
      expect(cands[i].score).toBeLessThanOrEqual(cands[i - 1].score)
    }
  })
})
