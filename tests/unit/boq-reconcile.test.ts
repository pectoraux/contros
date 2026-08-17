/**
 * Unit tests for the pure BOQ reconciliation function.
 *
 * Reconciliation is a deterministic RESULT, not stored truth. These tests
 * establish the comparison contract and the asymmetric rate rule
 * (RATE_DIVERGENT never implies the external rate should replace canonical).
 */

import { test, expect, describe } from 'bun:test'
import {
  reconcile,
  reconcileBatch,
  summarizeResults,
} from '../../src/lib/boq/reconcile'

describe('BOQ reconciliation — MATCHED with full match', () => {
  test('all dimensions match → no differences', () => {
    const r = reconcile({
      item: {
        boqItemId: 'i1',
        normalizedQuantity: 100,
        normalizedUnit: 'm',
        normalizedRate: 10,
      },
      line: {
        estimateLineId: 'l1',
        quantity: 100,
        unit: 'm',
        unitRate: 10,
      },
      bindingStatus: 'MATCHED',
    })
    expect(r.bindingStatus).toBe('MATCHED')
    expect(r.estimateLineId).toBe('l1')
    expect(r.quantity.status).toBe('MATCH')
    expect(r.unit.status).toBe('MATCH')
    expect(r.rate.status).toBe('MATCH')
    expect(r.differences).toHaveLength(0)
    expect(r.classification).toEqual(['MATCHED'])
  })
})

describe('BOQ reconciliation — QTY_MISMATCH', () => {
  test('quantity differs → QTY_MISMATCH in differences', () => {
    const r = reconcile({
      item: {
        boqItemId: 'i2',
        normalizedQuantity: 120,
        normalizedUnit: 'm',
        normalizedRate: 10,
      },
      line: {
        estimateLineId: 'l2',
        quantity: 100,
        unit: 'm',
        unitRate: 10,
      },
      bindingStatus: 'MATCHED',
    })
    expect(r.quantity.status).toBe('MISMATCH')
    expect(r.quantity.external).toBe(120)
    expect(r.quantity.canonical).toBe(100)
    expect(r.differences.some((d) => d.kind === 'QTY_MISMATCH')).toBe(true)
    expect(r.classification).toContain('QTY_MISMATCH')
  })
})

describe('BOQ reconciliation — UNIT_MISMATCH', () => {
  test('unit differs → UNIT_MISMATCH', () => {
    const r = reconcile({
      item: {
        boqItemId: 'i3',
        normalizedQuantity: 100,
        normalizedUnit: 'm2',
        normalizedRate: 10,
      },
      line: {
        estimateLineId: 'l3',
        quantity: 100,
        unit: 'm',
        unitRate: 10,
      },
      bindingStatus: 'MATCHED',
    })
    expect(r.unit.status).toBe('MISMATCH')
    expect(r.differences.some((d) => d.kind === 'UNIT_MISMATCH')).toBe(true)
  })
})

describe('BOQ reconciliation — RATE_DIVERGENT (asymmetric)', () => {
  test('rate differs → RATE_DIVERGENT, never a price replacement', () => {
    const r = reconcile({
      item: {
        boqItemId: 'i4',
        normalizedQuantity: 100,
        normalizedUnit: 'm',
        normalizedRate: 45, // external observation
      },
      line: {
        estimateLineId: 'l4',
        quantity: 100,
        unit: 'm',
        unitRate: 52, // canonical — AUTHORITATIVE
      },
      bindingStatus: 'MATCHED',
    })
    expect(r.rate.status).toBe('DIVERGENT')
    expect(r.rate.external).toBe(45)
    expect(r.rate.canonical).toBe(52)
    const diff = r.differences.find((d) => d.kind === 'RATE_DIVERGENT')!
    expect(diff).toBeDefined()
    expect(diff.external).toBe(45)
    expect(diff.canonical).toBe(52)
    // The note must remind that canonical is authoritative.
    expect(diff.note).toMatch(/authoritative/i)
  })

  test('multiple differences can coexist (dimensions, not exclusive statuses)', () => {
    const r = reconcile({
      item: {
        boqItemId: 'i5',
        normalizedQuantity: 120,
        normalizedUnit: 'm2',
        normalizedRate: 45,
      },
      line: {
        estimateLineId: 'l5',
        quantity: 100,
        unit: 'm',
        unitRate: 52,
      },
      bindingStatus: 'MATCHED',
    })
    expect(r.differences).toHaveLength(3)
    expect(r.classification).toEqual(['MATCHED', 'QTY_MISMATCH', 'UNIT_MISMATCH', 'RATE_DIVERGENT'])
  })
})

describe('BOQ reconciliation — non-MATCHED bindings', () => {
  test('UNMATCHED → all UNKNOWN, no differences', () => {
    const r = reconcile({
      item: {
        boqItemId: 'i6',
        normalizedQuantity: 100,
        normalizedUnit: 'm',
        normalizedRate: 10,
      },
      line: null,
      bindingStatus: 'UNMATCHED',
    })
    expect(r.bindingStatus).toBe('UNMATCHED')
    expect(r.estimateLineId).toBeNull()
    expect(r.quantity.status).toBe('UNKNOWN')
    expect(r.unit.status).toBe('UNKNOWN')
    expect(r.rate.status).toBe('UNKNOWN')
    expect(r.differences).toHaveLength(0)
    expect(r.classification).toEqual(['UNMATCHED'])
  })

  test('AMBIGUOUS → all UNKNOWN, no differences', () => {
    const r = reconcile({
      item: {
        boqItemId: 'i7',
        normalizedQuantity: 100,
        normalizedUnit: 'm',
        normalizedRate: 10,
      },
      line: null,
      bindingStatus: 'AMBIGUOUS',
    })
    expect(r.bindingStatus).toBe('AMBIGUOUS')
    expect(r.differences).toHaveLength(0)
  })

  test('REJECTED → all UNKNOWN, no differences', () => {
    const r = reconcile({
      item: {
        boqItemId: 'i8',
        normalizedQuantity: 100,
        normalizedUnit: 'm',
        normalizedRate: 10,
      },
      line: null,
      bindingStatus: 'REJECTED',
    })
    expect(r.bindingStatus).toBe('REJECTED')
    expect(r.differences).toHaveLength(0)
  })
})

describe('BOQ reconciliation — UNKNOWN external values', () => {
  test('null external quantity → UNKNOWN, not MISMATCH', () => {
    const r = reconcile({
      item: {
        boqItemId: 'i9',
        normalizedQuantity: null,
        normalizedUnit: 'm',
        normalizedRate: 10,
      },
      line: {
        estimateLineId: 'l9',
        quantity: 100,
        unit: 'm',
        unitRate: 10,
      },
      bindingStatus: 'MATCHED',
    })
    expect(r.quantity.status).toBe('UNKNOWN')
    expect(r.differences.some((d) => d.kind === 'QTY_MISMATCH')).toBe(false)
  })
})

describe('BOQ reconciliation — float tolerance', () => {
  test('near-equal floats match within tolerance', () => {
    const r = reconcile({
      item: {
        boqItemId: 'i10',
        normalizedQuantity: 100.0000001,
        normalizedUnit: 'm',
        normalizedRate: 10,
      },
      line: {
        estimateLineId: 'l10',
        quantity: 100,
        unit: 'm',
        unitRate: 10,
      },
      bindingStatus: 'MATCHED',
    })
    expect(r.quantity.status).toBe('MATCH')
  })
})

describe('BOQ reconciliation — batch + summary', () => {
  test('reconcileBatch processes multiple entries', () => {
    const results = reconcileBatch([
      {
        item: { boqItemId: 'b1', normalizedQuantity: 100, normalizedUnit: 'm', normalizedRate: 10 },
        line: { estimateLineId: 'lb1', quantity: 100, unit: 'm', unitRate: 10 },
        bindingStatus: 'MATCHED' as const,
      },
      {
        item: { boqItemId: 'b2', normalizedQuantity: 50, normalizedUnit: 'm', normalizedRate: 20 },
        line: { estimateLineId: 'lb2', quantity: 60, unit: 'm', unitRate: 25 },
        bindingStatus: 'MATCHED' as const,
      },
      {
        item: { boqItemId: 'b3', normalizedQuantity: 10, normalizedUnit: 'm', normalizedRate: 5 },
        line: null,
        bindingStatus: 'UNMATCHED' as const,
      },
    ])
    expect(results).toHaveLength(3)
    const sum = summarizeResults(results)
    expect(sum.total).toBe(3)
    expect(sum.matched).toBe(2)
    expect(sum.unmatched).toBe(1)
    expect(sum.withDifferences).toBe(1) // b2 has qty + rate divergence
    expect(sum.qtyMismatches).toBe(1)
    expect(sum.rateDivergences).toBe(1)
  })
})

describe('BOQ reconciliation — determinism', () => {
  test('same input always produces same output', () => {
    const input = {
      item: { boqItemId: 'd1', normalizedQuantity: 120, normalizedUnit: 'm', normalizedRate: 45 },
      line: { estimateLineId: 'ld1', quantity: 100, unit: 'm', unitRate: 52 },
      bindingStatus: 'MATCHED' as const,
    }
    const a = reconcile(input)
    const b = reconcile(input)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
