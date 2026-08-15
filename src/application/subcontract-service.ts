/**
 * SubcontractService — application service for subcontract package operations.
 *
 * Owns: tenant validation, ownership resolution, reconciliation-engine
 * invocation, persistence, commercial exception creation/lookup, audit logging,
 * and transaction boundaries.
 *
 * Does NOT own: reconciliation math (that stays in the pure
 * `reconcileSubcontract` engine).
 *
 * Architecture mirrors the frozen EstimateService pattern exactly:
 *   - Receives `ctx: RequestContext` for tenant scoping.
 *   - All data access via tenant-aware repositories (no raw Prisma in the
 *     service except for the atomic $transaction that touches multiple tables).
 *   - Commercially significant actions are wrapped in `dbTx.$transaction` so
 *     package update + quote update + audit log succeed or fail together.
 *
 * API routes become thin adapters that call this service.
 *
 * INVARIANT 7: Subcontract scope must be reconciled against required scope.
 * INVARIANT 12: Every organization is isolated.
 */

import { db, dbTx } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import {
  reconcileSubcontract,
  type ReconcileSubcontractInput,
  type ReconciliationResult,
  type ScopeAtomInput,
  type QuoteScopeCoverageInput,
} from '@/lib/engines'
import { round2 } from '@/lib/engines/money'
import {
  subcontractPackageRepository,
  subcontractQuoteRepository,
  scopeAtomRepository,
  quoteScopeCoverageRepository,
  commercialExceptionRepository,
  auditLogRepository,
} from '@/repositories'

// ─── Types ──────────────────────────────────────────────────────────────────

export type PackageStatus =
  | 'draft'
  | 'enquiry-sent'
  | 'quotes-received'
  | 'awarded'
  | 'abandoned'

export type QuoteStatus = 'received' | 'selected' | 'rejected'

export type CoverageStatus = 'covered' | 'excluded' | 'unstated'

export interface GetPackageWorkspaceInput {
  ctx: RequestContext
  opportunityId: string
}

export interface WorkspaceQuote {
  id: string
  supplierName: string
  totalAmount: number
  currency: string
  status: string
  receivedAt: Date
  exclusions: string[]
  assumptions: string[]
  coveragePct: number
  coverageBasis: 'atoms' | 'lump-sum' | 'none'
  isLumpSum: boolean
  semanticCoveragePct: number
  economicCoveragePct: number
  economicCoverageUnknown: boolean
  atomReconciliations: ReconciliationResult['atomReconciliations']
  excludedAtoms: string[]
  unstatedAtoms: string[]
  coveredAtoms: string[]
  coveredScopeValue: number
  uncoveredValue: number
  gaps: string[]
  warnings: string[]
  reconciliationStatus: ReconciliationResult['status']
}

export interface WorkspacePackage {
  id: string
  name: string
  scope: string | null
  executionStrategy: string
  status: string
  selectedQuoteId: string | null
  scopeAtoms: Array<{
    id: string
    name: string
    description: string | null
    valueWeight: number
  }>
  requiredLines: Array<{
    id: string
    description: string
    sellPrice: number
  }>
  requiredScopeValue: number
  quotes: WorkspaceQuote[]
  selectedQuote: WorkspaceQuote | null
  hasUnselectedQuote: boolean
  hasNoQuotes: boolean
  // P0-2: Graph inconsistency — a package line references a cross-tenant EstimateLine.
  graphInconsistent: boolean
  // P0-2: When graphInconsistent, reconciliation is blocked — the engine is NOT called.
  reconciliationBlocked: boolean
  // P0-2: Human-readable blockers explaining why reconciliation was skipped.
  blockers: string[]
}

export interface GetPackageWorkspaceResult {
  ok: true
  packages: WorkspacePackage[]
}

export interface CreatePackageInput {
  ctx: RequestContext
  opportunityId: string
  name: string
  scope?: string
  executionStrategy: 'self-perform' | 'subcontract' | 'hybrid' | 'undecided'
}

export interface CreatePackageResult {
  ok: true
  package: {
    id: string
    opportunityId: string
    name: string
    scope: string | null
    executionStrategy: string
    status: string
  }
}

export interface CreateScopeAtomInput {
  ctx: RequestContext
  packageId: string
  name: string
  description?: string
  valueWeight: number
}

export interface CreateScopeAtomResult {
  ok: true
  scopeAtom: {
    id: string
    packageId: string
    name: string
    description: string | null
    valueWeight: number
  }
}

export interface RecordQuoteInput {
  ctx: RequestContext
  packageId: string
  supplierName: string
  totalAmount: number
  currency: string
  exclusions?: string[]
  assumptions?: string[]
}

export interface RecordQuoteResult {
  ok: true
  quote: {
    id: string
    packageId: string
    supplierName: string
    totalAmount: number
    currency: string
    exclusions: string[]
    assumptions: string[]
    status: string
  }
}

export interface RecordQuoteScopeCoverageInput {
  ctx: RequestContext
  quoteId: string
  scopeAtomId: string
  status: CoverageStatus
  note?: string
}

export interface RecordQuoteScopeCoverageResult {
  ok: true
  coverage: {
    id: string
    quoteId: string
    scopeAtomId: string
    status: string
    note: string | null
  }
}

export interface ReconcileQuoteInput {
  ctx: RequestContext
  packageId: string
  quoteId: string
}

export interface ReconcileQuoteResult {
  ok: true
  reconciliation: ReconciliationResult
}

export interface SelectQuoteInput {
  ctx: RequestContext
  packageId: string
  quoteId: string
}

export interface SelectQuoteResult {
  ok: true
  packageId: string
  selectedQuoteId: string
  packageStatus: string
  reconciliation: ReconciliationResult
}

export interface RejectQuoteInput {
  ctx: RequestContext
  quoteId: string
}

export interface RejectQuoteResult {
  ok: true
  quoteId: string
  status: string
}

export interface TransitionPackageStatusInput {
  ctx: RequestContext
  packageId: string
  status: PackageStatus
}

export interface TransitionPackageStatusResult {
  ok: true
  packageId: string
  status: string
}

type Err = { ok: false; error: string; status: number }

// ─── State machine helpers ───────────────────────────────────────────────────

/**
 * Allowed forward transitions for a SubcontractPackage.
 *
 *   draft → enquiry-sent → quotes-received → awarded
 *   any state → abandoned
 *   abandoned → draft (restart cycle)
 *
 * Selecting a quote (selectQuote) can move the package to `awarded` from any
 * pre-award state (draft / enquiry-sent / quotes-received) — a single-source
 * supplier or an early award is a valid business action.
 *
 * Cannot go from `awarded` back to any pre-award state without first
 * abandoning. Re-awarding (awarded → awarded) is rejected — the caller must
 * abandon first to start a new selection cycle.
 */
const STATE_TRANSITIONS: Record<string, PackageStatus[]> = {
  draft: ['enquiry-sent', 'quotes-received', 'awarded', 'abandoned'],
  'enquiry-sent': ['draft', 'quotes-received', 'awarded', 'abandoned'],
  'quotes-received': ['draft', 'enquiry-sent', 'awarded', 'abandoned'],
  awarded: ['abandoned'],
  abandoned: ['draft'],
}

function isAllowedTransition(from: string, to: string): boolean {
  const allowed = STATE_TRANSITIONS[from]
  if (!allowed) return false
  return (allowed as string[]).includes(to)
}

// ─── Input validation helpers ────────────────────────────────────────────────

function isValidValueWeight(w: unknown): w is number {
  return (
    typeof w === 'number' &&
    Number.isFinite(w) &&
    !Number.isNaN(w) &&
    w >= 0 &&
    w <= 1
  )
}

function isValidAmount(a: unknown): a is number {
  return (
    typeof a === 'number' &&
    Number.isFinite(a) &&
    !Number.isNaN(a) &&
    a >= 0
  )
}

function isCoverageStatus(s: unknown): s is CoverageStatus {
  return s === 'covered' || s === 'excluded' || s === 'unstated'
}

function isPackageStatus(s: unknown): s is PackageStatus {
  return (
    s === 'draft' ||
    s === 'enquiry-sent' ||
    s === 'quotes-received' ||
    s === 'awarded' ||
    s === 'abandoned'
  )
}

// ─── Internal: build the reconciliation input from a loaded package ──────────

interface LoadedPackage {
  id: string
  name: string
  scope: string | null
  executionStrategy: string
  status: string
  selectedQuoteId: string | null
  scopeAtoms: Array<{
    id: string
    name: string
    description: string | null
    valueWeight: number
  }>
  lines: Array<{
    estimateLineId: string
    requiredScope: string
    estimateLine: { sellPrice: number; description: string } | null
  }>
  quotes: Array<{
    id: string
    supplierName: string
    totalAmount: number
    currency: string
    status: string
    receivedAt: Date
    exclusionsJson: string
    assumptionsJson: string
    coveragePct: number
    scopeCoverages: Array<{
      scopeAtomId: string
      status: string
      note: string | null
    }>
  }>
}

function buildRequiredLines(pkg: LoadedPackage, orgId?: string) {
  return pkg.lines.map((l) => {
    // P0-2: Verify estimateLine ownership. If the estimateLine's estimate
    // belongs to a different org, treat it as unavailable (null).
    const estimateOrgId = (l.estimateLine as unknown as { estimate?: { organizationId?: string } })?.estimate?.organizationId
    const isCrossTenant = !!l.estimateLine && orgId && estimateOrgId !== orgId
    const effectiveEstimateLine = isCrossTenant ? null : l.estimateLine

    return {
      id: l.estimateLineId,
      description: l.requiredScope || effectiveEstimateLine?.description || '',
      sellPrice: effectiveEstimateLine?.sellPrice ?? 0,
      // P0-2: Flag inconsistent graph state — estimateLine was filtered out as
      // cross-tenant. The service should not silently undercount required scope.
      estimateLineMissing: (!!l.estimateLineId && !l.estimateLine) || isCrossTenant,
    }
  })
}

function buildScopeAtoms(pkg: LoadedPackage): ScopeAtomInput[] {
  return pkg.scopeAtoms.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description ?? undefined,
    valueWeight: a.valueWeight,
  }))
}

function buildReconciliationInput(
  requiredLines: Array<{ id: string; description: string; sellPrice: number }>,
  pkg: LoadedPackage,
  quote: LoadedPackage['quotes'][number] | null,
): ReconcileSubcontractInput {
  const scopeAtoms = buildScopeAtoms(pkg)
  if (!quote) {
    return { requiredLines, scopeAtoms, quote: null }
  }
  const scopeCoverages: QuoteScopeCoverageInput[] = quote.scopeCoverages.map((c) => ({
    scopeAtomId: c.scopeAtomId,
    status: c.status as 'covered' | 'excluded' | 'unstated',
    note: c.note ?? undefined,
  }))
  return {
    requiredLines,
    scopeAtoms,
    quote: {
      id: quote.id,
      totalAmount: quote.totalAmount,
      scopeCoverages,
      exclusionsJson: quote.exclusionsJson,
      assumptionsJson: quote.assumptionsJson,
    },
  }
}

function toWorkspaceQuote(
  q: LoadedPackage['quotes'][number],
  reconciliation: ReconciliationResult,
): WorkspaceQuote {
  return {
    id: q.id,
    supplierName: q.supplierName,
    totalAmount: q.totalAmount,
    currency: q.currency,
    status: q.status,
    receivedAt: q.receivedAt,
    exclusions: parseStringArray(q.exclusionsJson),
    assumptions: parseStringArray(q.assumptionsJson),
    coveragePct: reconciliation.coveragePct,
    coverageBasis: reconciliation.coverageBasis,
    isLumpSum: reconciliation.isLumpSum,
    semanticCoveragePct: reconciliation.semanticCoveragePct,
    economicCoveragePct: reconciliation.economicCoveragePct,
    economicCoverageUnknown: reconciliation.economicCoverageUnknown,
    atomReconciliations: reconciliation.atomReconciliations,
    excludedAtoms: reconciliation.excludedAtoms,
    unstatedAtoms: reconciliation.unstatedAtoms,
    coveredAtoms: reconciliation.coveredAtoms,
    coveredScopeValue: reconciliation.coveredScopeValue,
    uncoveredValue: reconciliation.uncoveredValue,
    gaps: reconciliation.gaps,
    warnings: reconciliation.warnings,
    reconciliationStatus: reconciliation.status,
  }
}

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    /* ignore */
  }
  return []
}

// ─── SubcontractService ─────────────────────────────────────────────────────

export const subcontractService = {
  /**
   * Get the full package workspace for an opportunity.
   *
   * Replaces the previous GET /api/subcontract/[opportunityId] logic.
   * The service:
   *   1. Verifies opportunity ownership (tenant-safe).
   *   2. Loads all packages for the opportunity with full graph.
   *   3. For each quote, runs the pure reconciliation engine.
   *   4. Returns the structured workspace.
   */
  async getPackageWorkspace(
    input: GetPackageWorkspaceInput,
  ): Promise<GetPackageWorkspaceResult | Err> {
    const { ctx, opportunityId } = input

    // 1. Tenant-safe load via repository (verifies opportunity ownership too).
    const packages = await subcontractPackageRepository.getForOpportunity(
      ctx.organizationId,
      opportunityId,
    )

    // 2. Build workspace, running reconciliation per quote.
    // P0-2: Check for inconsistent graph state (cross-tenant estimateLine references).
    // If inconsistent, DO NOT call reconcileSubcontract() — the engine must not
    // receive foreign-tenant pricing data.
    const workspacePackages: WorkspacePackage[] = packages.map((sp) => {
      const loadedPkg = sp as unknown as LoadedPackage
      const requiredLines = buildRequiredLines(loadedPkg, ctx.organizationId)
      const scopeAtoms = buildScopeAtoms(loadedPkg)
      const requiredScopeValue = round2(
        requiredLines.reduce((s, l) => s + l.sellPrice, 0),
      )

      // P0-2: If any package line references an estimateLine that was filtered
      // out as cross-tenant, flag the workspace as inconsistent and BLOCK
      // reconciliation entirely. Do not feed foreign data into the engine.
      const hasInconsistentGraph = requiredLines.some((l) => l.estimateLineMissing)

      const blockers: string[] = []
      if (hasInconsistentGraph) {
        blockers.push(
          'Required estimate scope contains an invalid cross-organization reference. Reconciliation blocked.',
        )
      }

      // P0-2: Only call the reconciliation engine if the graph is consistent.
      let quotes: WorkspaceQuote[]
      if (hasInconsistentGraph) {
        // Blocked — return quotes without reconciliation results.
        quotes = loadedPkg.quotes.map((q) => ({
          id: q.id,
          supplierName: q.supplierName,
          totalAmount: q.totalAmount,
          currency: q.currency,
          status: q.status,
          receivedAt: q.receivedAt,
          exclusions: JSON.parse(q.exclusionsJson || '[]'),
          assumptions: JSON.parse(q.assumptionsJson || '[]'),
          coveragePct: 0,
          coverageBasis: 'none' as const,
          isLumpSum: false,
          semanticCoveragePct: 0,
          economicCoveragePct: 0,
          economicCoverageUnknown: true,
          atomReconciliations: [],
          excludedAtoms: [],
          unstatedAtoms: [],
          coveredAtoms: [],
          coveredScopeValue: 0,
          uncoveredValue: requiredScopeValue,
          gaps: ['Reconciliation blocked — inconsistent package graph'],
          warnings: ['Reconciliation blocked due to cross-tenant estimate line reference.'],
          reconciliationStatus: 'blocker' as const,
        }))
      } else {
        quotes = loadedPkg.quotes.map((q) => {
          const reconciliationInput = buildReconciliationInput(requiredLines, loadedPkg, q)
          const result = reconcileSubcontract(reconciliationInput)
          return toWorkspaceQuote(q, result)
        })
      }

      const selectedQuote =
        quotes.find((q) => q.id === sp.selectedQuoteId) ?? null

      return {
        id: sp.id,
        name: sp.name,
        scope: sp.scope,
        executionStrategy: sp.executionStrategy,
        status: sp.status,
        selectedQuoteId: sp.selectedQuoteId,
        scopeAtoms: scopeAtoms.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description ?? null,
          valueWeight: a.valueWeight ?? 0,
        })),
        requiredLines: requiredLines.map((l) => ({
          id: l.id,
          description: l.description,
          sellPrice: l.sellPrice,
        })),
        requiredScopeValue,
        quotes,
        selectedQuote,
        hasUnselectedQuote: !sp.selectedQuoteId && quotes.length > 0,
        hasNoQuotes: quotes.length === 0,
        // P0-2: Surface inconsistent graph state — do not silently undercount.
        graphInconsistent: hasInconsistentGraph,
        reconciliationBlocked: hasInconsistentGraph,
        blockers,
      }
    })

    return { ok: true, packages: workspacePackages }
  },

  /**
   * Create a subcontract package.
   *
   * Tenant-safe: the repository verifies opportunity ownership. If the
   * opportunity doesn't exist OR belongs to another org, returns 404.
   *
   * P0-1: package creation + audit log are wrapped in `dbTx.$transaction` so
   * they succeed or fail atomically — a package without an audit trail (or
   * an audit trail without a package) is impossible.
   */
  async createPackage(
    input: CreatePackageInput,
  ): Promise<CreatePackageResult | Err> {
    const { ctx, opportunityId, name, scope, executionStrategy } = input

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, error: 'Package name is required', status: 400 }
    }

    const pkg = await dbTx.$transaction(async (tx) => {
      const created = await subcontractPackageRepository.createForOrganizationInTransaction(
        tx,
        ctx.organizationId,
        {
          opportunityId,
          name: name.trim(),
          scope: scope ?? null,
          executionStrategy,
        },
      )
      if (!created) return null
      await auditLogRepository.createInTransaction(
        tx,
        ctx.organizationId,
        ctx.userId,
        {
          action: 'subcontract.package-created',
          entityType: 'SubcontractPackage',
          entityId: created.id,
          summary: `Subcontract package "${created.name}" created for opportunity ${opportunityId} (strategy: ${executionStrategy})`,
          afterJson: JSON.stringify({
            packageId: created.id,
            opportunityId,
            name: created.name,
            executionStrategy: created.executionStrategy,
            status: created.status,
          }),
        },
      )
      return created
    })
    if (!pkg) {
      return {
        ok: false,
        error: 'Opportunity not found in this organization',
        status: 404,
      }
    }

    return {
      ok: true,
      package: {
        id: pkg.id,
        opportunityId: pkg.opportunityId,
        name: pkg.name,
        scope: pkg.scope,
        executionStrategy: pkg.executionStrategy,
        status: pkg.status,
      },
    }
  },

  /**
   * Add a required scope atom to a package.
   *
   * Validates `valueWeight` is in [0, 1]. Tenant-safe: the repository verifies
   * package ownership. If the package belongs to another org, returns 404.
   */
  async createScopeAtom(
    input: CreateScopeAtomInput,
  ): Promise<CreateScopeAtomResult | Err> {
    const { ctx, packageId, name, description, valueWeight } = input

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, error: 'Scope atom name is required', status: 400 }
    }
    if (!isValidValueWeight(valueWeight)) {
      return {
        ok: false,
        error: `valueWeight must be a finite number in [0, 1] — got ${valueWeight}`,
        status: 400,
      }
    }

    // P0: Transactional — scope atom + audit succeed or fail together.
    const atom = await dbTx.$transaction(async (tx) => {
      const created = await scopeAtomRepository.createForPackageInTransaction(
        tx,
        ctx.organizationId,
        packageId,
        {
          name: name.trim(),
          description: description ?? null,
          valueWeight,
        },
      )
      if (!created) return null

      await auditLogRepository.createInTransaction(
        tx,
        ctx.organizationId,
        ctx.userId,
        {
          action: 'subcontract.scope-atom-created',
          entityType: 'ScopeAtom',
          entityId: created.id,
          summary: `Scope atom "${created.name}" (weight ${created.valueWeight}) added to package ${packageId}`,
        },
      )

      return created
    })
    if (!atom) {
      return {
        ok: false,
        error: 'Package not found in this organization',
        status: 404,
      }
    }

    return {
      ok: true,
      scopeAtom: {
        id: atom.id,
        packageId: atom.subcontractPackageId,
        name: atom.name,
        description: atom.description,
        valueWeight: atom.valueWeight,
      },
    }
  },

  /**
   * Record a subcontract quote.
   *
   * Validates `totalAmount` is a non-negative finite number. Tenant-safe: the
   * repository verifies package ownership.
   *
   * P0-1: quote creation + audit log are wrapped in `dbTx.$transaction` so they
   * succeed or fail atomically — a quote without an audit trail (or vice
   * versa) is impossible.
   */
  async recordQuote(
    input: RecordQuoteInput,
  ): Promise<RecordQuoteResult | Err> {
    const {
      ctx,
      packageId,
      supplierName,
      totalAmount,
      currency,
      exclusions,
      assumptions,
    } = input

    if (!supplierName || typeof supplierName !== 'string' || supplierName.trim().length === 0) {
      return { ok: false, error: 'supplierName is required', status: 400 }
    }
    if (!isValidAmount(totalAmount)) {
      return {
        ok: false,
        error: `totalAmount must be a finite non-negative number — got ${totalAmount}`,
        status: 400,
      }
    }
    if (!currency || typeof currency !== 'string' || currency.trim().length === 0) {
      return { ok: false, error: 'currency is required', status: 400 }
    }

    const exclusionsArr = exclusions ?? []
    const assumptionsArr = assumptions ?? []
    const exclusionsJson = JSON.stringify(exclusionsArr)
    const assumptionsJson = JSON.stringify(assumptionsArr)

    const quote = await dbTx.$transaction(async (tx) => {
      const created = await subcontractQuoteRepository.createForPackageInTransaction(
        tx,
        ctx.organizationId,
        packageId,
        {
          supplierName: supplierName.trim(),
          totalAmount,
          currency: currency.trim(),
          exclusionsJson,
          assumptionsJson,
        },
      )
      if (!created) return null
      await auditLogRepository.createInTransaction(
        tx,
        ctx.organizationId,
        ctx.userId,
        {
          action: 'subcontract.quote-recorded',
          entityType: 'SubcontractQuote',
          entityId: created.id,
          summary: `Quote from "${created.supplierName}" recorded for package ${packageId}: ${currency} ${totalAmount.toFixed(2)}`,
          afterJson: JSON.stringify({
            quoteId: created.id,
            packageId,
            supplierName: created.supplierName,
            totalAmount: created.totalAmount,
            currency: created.currency,
            exclusionsCount: exclusionsArr.length,
            assumptionsCount: assumptionsArr.length,
          }),
        },
      )
      return created
    })
    if (!quote) {
      return {
        ok: false,
        error: 'Package not found in this organization',
        status: 404,
      }
    }

    return {
      ok: true,
      quote: {
        id: quote.id,
        packageId: quote.subcontractPackageId,
        supplierName: quote.supplierName,
        totalAmount: quote.totalAmount,
        currency: quote.currency,
        exclusions: exclusionsArr,
        assumptions: assumptionsArr,
        status: quote.status,
      },
    }
  },

  /**
   * Record or update quote scope coverage for a specific atom.
   *
   * Tenant-safe: the repository verifies quote + scopeAtom belong to the same
   * package+org. If either is cross-tenant OR they belong to different
   * packages, returns 404.
   */
  async recordQuoteScopeCoverage(
    input: RecordQuoteScopeCoverageInput,
  ): Promise<RecordQuoteScopeCoverageResult | Err> {
    const { ctx, quoteId, scopeAtomId, status, note } = input

    if (!isCoverageStatus(status)) {
      return {
        ok: false,
        error: `status must be one of: covered, excluded, unstated — got ${status}`,
        status: 400,
      }
    }

    const coverage = await quoteScopeCoverageRepository.upsertForQuote(
      ctx.organizationId,
      quoteId,
      scopeAtomId,
      status,
      note,
    )
    if (!coverage) {
      return {
        ok: false,
        error:
          'Quote or scope atom not found, or they belong to different packages / organizations',
        status: 404,
      }
    }

    // Audit.
    await auditLogRepository.create(
      ctx.organizationId,
      ctx.userId,
      {
        action: 'subcontract.coverage-recorded',
        entityType: 'QuoteScopeCoverage',
        entityId: coverage.id,
        summary: `Coverage for atom ${scopeAtomId} on quote ${quoteId} set to "${status}"`,
      },
    )

    return {
      ok: true,
      coverage: {
        id: coverage.id,
        quoteId: coverage.quoteId,
        scopeAtomId: coverage.scopeAtomId,
        status: coverage.status,
        note: coverage.note,
      },
    }
  },

  /**
   * Reconcile a quote against the package's required scope atoms.
   *
   * Pure delegation: this method loads the tenant-safe package+quote graph,
   * builds the engine input, and calls `reconcileSubcontract()`. It does NOT
   * duplicate the reconciliation math.
   *
   * P0-1: persistence of the reconciled coveragePct on the quote + the audit
   * log are wrapped in `dbTx.$transaction` so they succeed or fail atomically.
   * The quote status is preserved — only `coveragePct` is updated.
   */
  async reconcileQuote(
    input: ReconcileQuoteInput,
  ): Promise<ReconcileQuoteResult | Err> {
    const { ctx, packageId, quoteId } = input

    // 1. Tenant-safe package load (full graph).
    const pkg = await subcontractPackageRepository.getForOrganization(
      ctx.organizationId,
      packageId,
    )
    if (!pkg) {
      return {
        ok: false,
        error: 'Package not found in this organization',
        status: 404,
      }
    }

    // 2. Find the quote within the package (verifies quote belongs to package).
    const loadedPkg = pkg as unknown as LoadedPackage
    const quote = loadedPkg.quotes.find((q) => q.id === quoteId)
    if (!quote) {
      return {
        ok: false,
        error: 'Quote not found in this package',
        status: 404,
      }
    }

    // 3. Build engine input + invoke pure reconciliation.
    // P0-2: Pass validated requiredLines (with orgId check) to prevent
    // cross-tenant estimateLine data from entering the engine.
    const validatedRequiredLines = buildRequiredLines(loadedPkg, ctx.organizationId)
    if (validatedRequiredLines.some((l) => l.estimateLineMissing)) {
      return {
        ok: false,
        error: 'Cannot reconcile: package graph is inconsistent (cross-tenant estimate line reference).',
        status: 403,
      }
    }
    const reconciliationInput = buildReconciliationInput(validatedRequiredLines, loadedPkg, quote)
    const result = reconcileSubcontract(reconciliationInput)

    // 4. Persist the reconciled coveragePct + write an audit log atomically.
    //    The quote.status is preserved — `updateStatusInTransaction` accepts
    //    an optional coveragePct alongside the status.
    await dbTx.$transaction(async (tx) => {
      await subcontractQuoteRepository.updateStatusInTransaction(
        tx,
        quoteId,
        quote.status,
        round2(result.coveragePct),
      )
      await auditLogRepository.createInTransaction(
        tx,
        ctx.organizationId,
        ctx.userId,
        {
          action: 'subcontract.quote-reconciled',
          entityType: 'SubcontractQuote',
          entityId: quoteId,
          summary: `Quote ${quoteId} ("${quote.supplierName}") reconciled — coverage ${Math.round(result.coveragePct * 100)}% (${result.coverageBasis}, ${result.status})`,
          afterJson: JSON.stringify({
            packageId,
            quoteId,
            coveragePct: result.coveragePct,
            economicCoveragePct: result.economicCoveragePct,
            semanticCoveragePct: result.semanticCoveragePct,
            economicCoverageUnknown: result.economicCoverageUnknown,
            coverageBasis: result.coverageBasis,
            status: result.status,
            isLumpSum: result.isLumpSum,
            excludedAtoms: result.excludedAtoms,
            unstatedAtoms: result.unstatedAtoms,
            coveredAtoms: result.coveredAtoms,
            uncoveredValue: result.uncoveredValue,
          }),
        },
      )
    })

    return { ok: true, reconciliation: result }
  },

  /**
   * Select a quote — guarded by reconciliation thresholds.
   *
   * Selection is REJECTED unless ALL of the following hold:
   *   - The quote is NOT lump-sum (isLumpSum === false), OR there is an
   *     approved CommercialException for this quote.
   *   - There are NO excluded scope atoms, OR there is an approved exception.
   *   - Economic coverage >= 0.8, OR there is an approved exception.
   *
   * If all checks pass, the selection is performed atomically within
   * `dbTx.$transaction`:
   *   - package.selectedQuoteId = quoteId
   *   - package.status = 'awarded'
   *   - quote.status = 'selected'
   *   - quote.coveragePct = reconciliation.coveragePct (persisted for downstream use)
   *   - An audit log entry is created.
   *
   * State machine: the package must NOT already be in `awarded` state (cannot
   * re-award without first abandoning). Going from any non-awarded state to
   * `awarded` is allowed.
   */
  async selectQuote(
    input: SelectQuoteInput,
  ): Promise<SelectQuoteResult | Err> {
    const { ctx, packageId, quoteId } = input

    // 1. Tenant-safe package load.
    const pkg = await subcontractPackageRepository.getForOrganization(
      ctx.organizationId,
      packageId,
    )
    if (!pkg) {
      return {
        ok: false,
        error: 'Package not found in this organization',
        status: 404,
      }
    }

    // 2. State machine: cannot select if already awarded.
    if (pkg.status === 'awarded') {
      return {
        ok: false,
        error:
          'Package is already awarded — abandon it first to re-select a quote',
        status: 400,
      }
    }
    if (pkg.status === 'abandoned') {
      return {
        ok: false,
        error: 'Cannot select a quote on an abandoned package',
        status: 400,
      }
    }

    // 3. Verify the quote belongs to this package.
    const loadedPkg = pkg as unknown as LoadedPackage
    const quote = loadedPkg.quotes.find((q) => q.id === quoteId)
    if (!quote) {
      return {
        ok: false,
        error: 'Quote not found in this package',
        status: 404,
      }
    }
    if (quote.status === 'rejected') {
      return {
        ok: false,
        error: 'Cannot select a rejected quote',
        status: 400,
      }
    }

    // 4. Run reconciliation (pure engine).
    // P0-2: Pass validated requiredLines to prevent cross-tenant data in engine.
    const validatedRequiredLines = buildRequiredLines(loadedPkg, ctx.organizationId)
    if (validatedRequiredLines.some((l) => l.estimateLineMissing)) {
      return {
        ok: false,
        error: 'Cannot select quote: package graph is inconsistent (cross-tenant estimate line reference).',
        status: 403,
      }
    }
    const reconciliationInput = buildReconciliationInput(validatedRequiredLines, loadedPkg, quote)
    const reconciliation = reconcileSubcontract(reconciliationInput)

    // 5. Check blockers. Each blocker can be overridden by an approved
    //    CommercialException for this quote.
    const approvedException =
      await commercialExceptionRepository.findApprovedForQuote(
        ctx.organizationId,
        quoteId,
      )

    const blockers: string[] = []
    if (reconciliation.isLumpSum) {
      blockers.push(
        'Quote is lump-sum (no scope-atom coverage). Lump-sum quotes are not accepted without an approved exception.',
      )
    }
    if (reconciliation.excludedAtoms.length > 0) {
      blockers.push(
        `Quote explicitly excludes ${reconciliation.excludedAtoms.length} critical scope atom(s): ${reconciliation.excludedAtoms.join(', ')}`,
      )
    }
    if (reconciliation.coveragePct < 0.8) {
      blockers.push(
        `Economic coverage ${Math.round(reconciliation.coveragePct * 100)}% is below the 80% threshold required for selection.`,
      )
    }

    if (blockers.length > 0 && !approvedException) {
      return {
        ok: false,
        error: `Cannot select quote — reconciliation blockers:\n  - ${blockers.join('\n  - ')}\nAn approved CommercialException is required to override.`,
        status: 400,
      }
    }

    // 6. Validate the state transition (any non-awarded → awarded).
    if (!isAllowedTransition(pkg.status, 'awarded')) {
      return {
        ok: false,
        error: `Illegal state transition: cannot move package from "${pkg.status}" to "awarded"`,
        status: 400,
      }
    }

    // 7. Atomic selection — package + quote + audit succeed or fail together.
    await dbTx.$transaction(async (tx) => {
      await subcontractPackageRepository.updateSelectionInTransaction(
        tx,
        packageId,
        quoteId,
        'awarded',
      )
      await subcontractQuoteRepository.updateStatusInTransaction(
        tx,
        quoteId,
        'selected',
        reconciliation.coveragePct,
      )
      await auditLogRepository.createInTransaction(
        tx,
        ctx.organizationId,
        ctx.userId,
        {
          action: 'subcontract.quote-selected',
          entityType: 'SubcontractPackage',
          entityId: packageId,
          summary: `Quote ${quoteId} ("${quote.supplierName}") selected for package ${packageId} — coverage ${Math.round(reconciliation.coveragePct * 100)}%, status ${reconciliation.status}${approvedException ? ' [approved exception override]' : ''}`,
          afterJson: JSON.stringify({
            packageId,
            quoteId,
            coveragePct: reconciliation.coveragePct,
            economicCoveragePct: reconciliation.economicCoveragePct,
            semanticCoveragePct: reconciliation.semanticCoveragePct,
            isLumpSum: reconciliation.isLumpSum,
            excludedAtoms: reconciliation.excludedAtoms,
            hadApprovedException: !!approvedException,
          }),
        },
      )
    })

    return {
      ok: true,
      packageId,
      selectedQuoteId: quoteId,
      packageStatus: 'awarded',
      reconciliation,
    }
  },

  /**
   * Reject a quote — sets quote.status = 'rejected'.
   *
   * Tenant-safe: the repository verifies quote ownership. If the quote is the
   * currently selected quote on its package, the package is also moved back
   * to `quotes-received` (state machine: awarded → quotes-received is allowed
   * via abandon → re-collect cycle, but rejecting a non-selected quote is a
   * no-op on the package).
   *
   * Rejecting the SELECTED quote is rejected with 400 — the caller must first
   * abandon the package to undo an awarded selection.
   */
  async rejectQuote(
    input: RejectQuoteInput,
  ): Promise<RejectQuoteResult | Err> {
    const { ctx, quoteId } = input

    // 1. Tenant-safe quote load (with parent package to check selection).
    const quote = await subcontractQuoteRepository.getWithCoveragesForOrganization(
      ctx.organizationId,
      quoteId,
    )
    if (!quote) {
      return {
        ok: false,
        error: 'Quote not found in this organization',
        status: 404,
      }
    }

    // 2. Cannot reject an already-selected quote (must abandon package first).
    if (quote.status === 'selected') {
      return {
        ok: false,
        error:
          'Cannot reject a selected quote — abandon the package first to undo the award',
        status: 400,
      }
    }
    if (quote.status === 'rejected') {
      // Idempotent — return success.
      return { ok: true, quoteId, status: 'rejected' }
    }

    // 3. Update + audit.
    const updated = await subcontractQuoteRepository.updateStatus(
      ctx.organizationId,
      quoteId,
      'rejected',
    )
    if (!updated) {
      return {
        ok: false,
        error: 'Quote not found in this organization',
        status: 404,
      }
    }

    await auditLogRepository.create(
      ctx.organizationId,
      ctx.userId,
      {
        action: 'subcontract.quote-rejected',
        entityType: 'SubcontractQuote',
        entityId: quoteId,
        summary: `Quote ${quoteId} ("${quote.supplierName}") rejected for package ${quote.subcontractPackageId}`,
      },
    )

    return { ok: true, quoteId, status: 'rejected' }
  },

  /**
   * Transition a package's status with state-machine validation.
   *
   * Used to move packages between draft / enquiry-sent / quotes-received /
   * awarded / abandoned. The `selectQuote()` method handles the
   * award transition atomically — this method handles all other transitions.
   *
   * State machine:
   *   draft → enquiry-sent → quotes-received → awarded
   *   any state → abandoned
   *   abandoned → draft (restart)
   *   awarded → abandoned (cancel award)
   *
   * NOT allowed:
   *   awarded → draft (must abandon first)
   *   awarded → enquiry-sent (must abandon first)
   *   awarded → quotes-received (must abandon first)
   */
  async transitionPackageStatus(
    input: TransitionPackageStatusInput,
  ): Promise<TransitionPackageStatusResult | Err> {
    const { ctx, packageId, status } = input

    if (!isPackageStatus(status)) {
      return {
        ok: false,
        error: `Invalid package status: ${status}. Must be one of: draft, enquiry-sent, quotes-received, awarded, abandoned`,
        status: 400,
      }
    }

    // 1. Tenant-safe package load.
    const pkg = await subcontractPackageRepository.getForOrganization(
      ctx.organizationId,
      packageId,
    )
    if (!pkg) {
      return {
        ok: false,
        error: 'Package not found in this organization',
        status: 404,
      }
    }

    // 2. Validate state transition.
    if (pkg.status === status) {
      // Idempotent — no transition needed.
      return { ok: true, packageId, status: pkg.status }
    }
    if (!isAllowedTransition(pkg.status, status)) {
      return {
        ok: false,
        error: `Illegal state transition: cannot move package from "${pkg.status}" to "${status}"`,
        status: 400,
      }
    }

    // 3. Update + audit.
    const updated = await subcontractPackageRepository.updateStatus(
      ctx.organizationId,
      packageId,
      status,
    )
    if (!updated) {
      return {
        ok: false,
        error: 'Package not found in this organization',
        status: 404,
      }
    }

    await auditLogRepository.create(
      ctx.organizationId,
      ctx.userId,
      {
        action: 'subcontract.package-status-changed',
        entityType: 'SubcontractPackage',
        entityId: packageId,
        summary: `Package ${packageId} status transitioned: "${pkg.status}" → "${status}"`,
        afterJson: JSON.stringify({ from: pkg.status, to: status }),
      },
    )

    return { ok: true, packageId, status: updated.status }
  },
}
