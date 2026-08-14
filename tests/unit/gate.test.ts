/**
 * Pre-Submission Gate Tests — P0-4 incomplete calculations, P0-8 exceptions.
 *
 * Run: bun test tests/unit/gate.test.ts
 */
import { test, expect, describe } from 'bun:test'
import { runPreSubmissionGate, type PreSubmissionGateInput } from '../../src/lib/engines/pre-submission-gate'
import { computeScopeCompleteness } from '../../src/lib/engines/scope-completeness'

const goodScope = computeScopeCompleteness(
  [
    { description: 'a', status: 'known' },
    { description: 'b', status: 'known' },
    { description: 'c', status: 'known' },
    { description: 'd', status: 'known' },
    { description: 'e', status: 'known' },
  ],
  [],
)

const baseInput = (overrides: Partial<PreSubmissionGateInput> = {}): PreSubmissionGateInput => ({
  scopeCompleteness: goodScope,
  unresolvedAssumptions: [],
  estimateLines: [
    { id: 'l1', description: 'Line 1', isUnsourced: false, acknowledged: true, unitRate: 100, calculationStatus: 'complete' },
    { id: 'l2', description: 'Line 2', isUnsourced: false, acknowledged: true, unitRate: 200, calculationStatus: 'complete' },
  ],
  subcontractPackages: [
    { id: 'sp1', name: 'Package 1', coveragePct: 1.0, selectedQuoteId: 'q1', isLumpSum: false },
  ],
  deliverables: { boq: true, programme: true, methodStatement: true, jha: true, tenderPack: true },
  commercialApproval: true,
  ...overrides,
})

describe('P0-4: incomplete calculations are blockers', () => {
  test('all lines complete → pass', () => {
    const result = runPreSubmissionGate(baseInput())
    expect(result.overall).toBe('pass')
    const check = result.checks.find((c) => c.id === 'incomplete-calculations')
    expect(check?.status).toBe('pass')
  })

  test('any line incomplete → blocker', () => {
    const result = runPreSubmissionGate(baseInput({
      estimateLines: [
        { id: 'l1', description: 'Line 1', isUnsourced: false, acknowledged: true, unitRate: 100, calculationStatus: 'complete' },
        { id: 'l2', description: 'Line 2', isUnsourced: false, acknowledged: true, unitRate: 200, calculationStatus: 'incomplete' },
      ],
    }))
    expect(result.overall).toBe('blocker')
    const check = result.checks.find((c) => c.id === 'incomplete-calculations')
    expect(check?.status).toBe('blocker')
    expect(check?.detail).toContain('1 line(s) with incomplete pricing')
  })
})

describe('P0-7: lump-sum quotes are blockers', () => {
  test('lump-sum selected quote → blocker', () => {
    const result = runPreSubmissionGate(baseInput({
      subcontractPackages: [
        { id: 'sp1', name: 'Package 1', coveragePct: 0, selectedQuoteId: 'q1', isLumpSum: true },
      ],
    }))
    const check = result.checks.find((c) => c.id === 'subcontract-coverage')
    expect(check?.status).toBe('blocker')
    expect(check?.detail).toContain('lump-sum')
  })
})

describe('P0-8: unsourced rates need acknowledgement AND approval', () => {
  test('unsourced unacknowledged → blocker', () => {
    const result = runPreSubmissionGate(baseInput({
      estimateLines: [
        { id: 'l1', description: 'Line 1', isUnsourced: true, acknowledged: false, unitRate: 100, calculationStatus: 'complete' },
      ],
    }))
    const check = result.checks.find((c) => c.id === 'unsourced-rates')
    expect(check?.status).toBe('blocker')
  })

  test('unsourced acknowledged but not director-approved → warning', () => {
    const result = runPreSubmissionGate(baseInput({
      estimateLines: [
        { id: 'l1', description: 'Line 1', isUnsourced: true, acknowledged: true, unitRate: 100, calculationStatus: 'complete', exceptionApproved: false },
      ],
    }))
    const check = result.checks.find((c) => c.id === 'unsourced-rates')
    expect(check?.status).toBe('warning')
    expect(check?.detail).toContain('not director-approved')
  })

  test('unsourced acknowledged AND director-approved → pass', () => {
    const result = runPreSubmissionGate(baseInput({
      estimateLines: [
        { id: 'l1', description: 'Line 1', isUnsourced: true, acknowledged: true, unitRate: 100, calculationStatus: 'complete', exceptionApproved: true },
      ],
    }))
    const check = result.checks.find((c) => c.id === 'unsourced-rates')
    expect(check?.status).toBe('pass')
  })
})

describe('scope completeness thresholds', () => {
  test('score < 0.5 → blocker', () => {
    const badScope = computeScopeCompleteness(
      [{ description: 'a', status: 'known' }, { description: 'b', status: 'missing' }, { description: 'c', status: 'missing' }],
      [],
    )
    const result = runPreSubmissionGate(baseInput({ scopeCompleteness: badScope }))
    const check = result.checks.find((c) => c.id === 'scope-completeness')
    expect(check?.status).toBe('blocker')
  })
})

describe('overall verdict is the worst check', () => {
  test('one blocker makes overall blocker', () => {
    const result = runPreSubmissionGate(baseInput({ commercialApproval: false }))
    expect(result.overall).toBe('blocker')
  })

  test('one warning (rest pass) makes overall warning', () => {
    const result = runPreSubmissionGate(baseInput({
      deliverables: { boq: true, programme: true, methodStatement: true, jha: true, tenderPack: false },
      commercialApproval: true,
    }))
    expect(result.overall).toBe('warning')
  })
})
