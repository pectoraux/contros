/**
 * Unit tests for the pure BOQ normalization functions.
 *
 * These are pure functions — no DB, no side effects. Deterministic: same
 * input → same output. The tests establish the normalization contract that
 * matching and reconciliation depend on.
 */

import { test, expect, describe } from 'bun:test'
import {
  parseNumber,
  normalizeUnit,
  normalizeDescription,
  normalizeCode,
  normalizeRow,
  normalizeRows,
} from '../../src/lib/boq/normalize'

describe('BOQ normalization — parseNumber', () => {
  test('parses plain numbers', () => {
    expect(parseNumber(42)).toBe(42)
    expect(parseNumber(3.14)).toBe(3.14)
    expect(parseNumber(0)).toBe(0)
    expect(parseNumber(-5)).toBe(-5)
  })

  test('parses numeric strings', () => {
    expect(parseNumber('42')).toBe(42)
    expect(parseNumber('3.14')).toBe(3.14)
    expect(parseNumber('-5')).toBe(-5)
  })

  test('strips currency symbols and thousands separators', () => {
    expect(parseNumber('GHS 1,234.56')).toBe(1234.56)
    expect(parseNumber('$1,000')).toBe(1000)
    expect(parseNumber('₵50.00')).toBe(50)
    expect(parseNumber('1,234,567.89')).toBe(1234567.89)
  })

  test('returns null for non-numeric content', () => {
    expect(parseNumber('not a number')).toBeNull()
    expect(parseNumber('')).toBeNull()
    expect(parseNumber(null)).toBeNull()
    expect(parseNumber(undefined)).toBeNull()
    expect(parseNumber(true)).toBeNull()
    expect(parseNumber(NaN)).toBeNull()
    expect(parseNumber(Infinity)).toBeNull()
  })

  test('handles empty/whitespace strings', () => {
    expect(parseNumber('  ')).toBeNull()
    expect(parseNumber('')).toBeNull()
  })
})

describe('BOQ normalization — normalizeUnit', () => {
  test('maps common variants to canonical tokens', () => {
    expect(normalizeUnit('m')).toBe('m')
    expect(normalizeUnit('mtrs')).toBe('m')
    expect(normalizeUnit('Meters')).toBe('m')
    expect(normalizeUnit('sq.m')).toBe('m2')
    expect(normalizeUnit('SQM')).toBe('m2')
    expect(normalizeUnit('cu.m')).toBe('m3')
    expect(normalizeUnit('nr')).toBe('nr')
    expect(normalizeUnit('No.')).toBe('nr')
    expect(normalizeUnit('each')).toBe('nr')
    expect(normalizeUnit('ton')).toBe('ton')
    expect(normalizeUnit('TONNES')).toBe('ton')
  })

  test('lowercases and trims unknown units', () => {
    expect(normalizeUnit('  KG  ')).toBe('kg')
    expect(normalizeUnit('Set')).toBe('set')
  })

  test('returns null for empty/null', () => {
    expect(normalizeUnit(null)).toBeNull()
    expect(normalizeUnit(undefined)).toBeNull()
    expect(normalizeUnit('')).toBeNull()
    expect(normalizeUnit('   ')).toBeNull()
  })
})

describe('BOQ normalization — normalizeDescription', () => {
  test('lowercases, trims, collapses whitespace', () => {
    expect(normalizeDescription('  PVC  Conduit  25mm  ')).toBe('pvc conduit 25mm')
    expect(normalizeDescription('CONCRETE WORK')).toBe('concrete work')
  })

  test('strips trailing periods', () => {
    expect(normalizeDescription('Excavation.')).toBe('excavation')
    expect(normalizeDescription('Backfill...')).toBe('backfill')
  })

  test('returns null for empty/null', () => {
    expect(normalizeDescription(null)).toBeNull()
    expect(normalizeDescription('')).toBeNull()
    expect(normalizeDescription('   ')).toBeNull()
  })
})

describe('BOQ normalization — normalizeCode', () => {
  test('uppercases and strips separators so variants match', () => {
    expect(normalizeCode('wd-014')).toBe('WD014')
    expect(normalizeCode('WD 014')).toBe('WD014')
    expect(normalizeCode('wd.014')).toBe('WD014')
    expect(normalizeCode('WD/014')).toBe('WD014')
    expect(normalizeCode('wd014')).toBe('WD014')
  })

  test('returns null for empty/null', () => {
    expect(normalizeCode(null)).toBeNull()
    expect(normalizeCode('')).toBeNull()
    expect(normalizeCode('   ')).toBeNull()
  })
})

describe('BOQ normalization — normalizeRow', () => {
  test('preserves raw values and computes normalized values', () => {
    const row = normalizeRow({
      worksheet: 'BOQ',
      rowNumber: 5,
      description: 'PVC Conduit 25mm',
      code: 'wd-014',
      quantity: '150',
      unit: 'Mtrs',
      rate: 'GHS 12.00',
      amount: 1800,
    })
    expect(row.worksheet).toBe('BOQ')
    expect(row.rowNumber).toBe(5)
    // raw preserved verbatim
    expect(row.rawDescription).toBe('PVC Conduit 25mm')
    expect(row.rawCode).toBe('wd-014')
    expect(row.rawQuantity).toBe(150)
    expect(row.rawUnit).toBe('Mtrs')
    expect(row.rawRate).toBe(12)
    expect(row.rawAmount).toBe(1800)
    // normalized
    expect(row.normalizedDescription).toBe('pvc conduit 25mm')
    expect(row.normalizedCode).toBe('WD014')
    expect(row.normalizedUnit).toBe('m')
    expect(row.normalizedQuantity).toBe(150)
    expect(row.normalizedRate).toBe(12)
  })

  test('handles null/missing fields gracefully', () => {
    const row = normalizeRow({
      worksheet: 'Sheet1',
      rowNumber: 1,
      description: null,
      code: undefined,
      quantity: null,
      unit: null,
      rate: null,
      amount: null,
    })
    expect(row.rawDescription).toBe('')
    expect(row.rawCode).toBeNull()
    expect(row.rawQuantity).toBeNull()
    expect(row.normalizedDescription).toBeNull()
    expect(row.normalizedCode).toBeNull()
    expect(row.normalizedUnit).toBeNull()
  })

  test('normalizeRows processes a batch', () => {
    const rows = normalizeRows([
      { worksheet: 'S', rowNumber: 1, description: 'A', code: null, quantity: 1, unit: 'm', rate: 10, amount: 10 },
      { worksheet: 'S', rowNumber: 2, description: 'B', code: null, quantity: 2, unit: 'm', rate: 20, amount: 40 },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].normalizedDescription).toBe('a')
    expect(rows[1].normalizedDescription).toBe('b')
  })
})
