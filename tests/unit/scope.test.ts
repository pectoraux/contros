/**
 * Scope Completeness Tests.
 *
 * Run: bun test tests/unit/scope.test.ts
 */
import { test, expect, describe } from 'bun:test'
import { computeScopeCompleteness } from '../../src/lib/engines/scope-completeness'

describe('scope completeness', () => {
  test('all known → 100%', () => {
    const result = computeScopeCompleteness(
      [
        { description: 'structural frame', status: 'known' },
        { description: 'roofing', status: 'known' },
        { description: 'blockwork', status: 'known' },
      ],
      [],
    )
    expect(result.score).toBe(1)
    expect(result.knownCount).toBe(3)
    expect(result.missingCount).toBe(0)
    expect(result.ambiguousCount).toBe(0)
  })

  test('one missing → 2/3', () => {
    const result = computeScopeCompleteness(
      [
        { description: 'structural', status: 'known' },
        { description: 'roofing', status: 'known' },
        { description: 'electrical', status: 'missing' },
      ],
      [],
    )
    expect(result.score).toBeCloseTo(2 / 3, 2)
    expect(result.missing).toContain('electrical')
  })

  test('one ambiguous → 2/3', () => {
    const result = computeScopeCompleteness(
      [
        { description: 'structural', status: 'known' },
        { description: 'roofing', status: 'known' },
        { description: 'fire protection', status: 'ambiguous' },
      ],
      [],
    )
    expect(result.score).toBeCloseTo(2 / 3, 2)
    expect(result.ambiguous).toContain('fire protection')
  })

  test('open questions are counted', () => {
    const result = computeScopeCompleteness(
      [{ description: 'a', status: 'known' }],
      [{ status: 'open' }, { status: 'open' }, { status: 'resolved' }],
    )
    expect(result.openQuestions).toBe(2)
  })

  test('empty items → 0', () => {
    const result = computeScopeCompleteness([], [])
    expect(result.score).toBe(0)
  })
})
