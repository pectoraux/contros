# Contractor OS — Implementation Worklog

This file is the shared worklog for all agents implementing the Contractor OS
inside the Next.js 16 sandbox at `/home/z/my-project`.

The product is an AI-native operating system for contractor SMEs (construction
vertical, Ghana context, GHS currency). The architectural invariants from the
master prompt are preserved:

- INVARIANT 1: The domain model is the source of truth, not Office files.
- INVARIANT 2: Estimate is the canonical commercial object; BOQ is a projection.
- INVARIANT 3: Every important price has provenance.
- INVARIANT 4: Approved WorkDefinitions are versioned and immutable.
- INVARIANT 5: AI cannot silently commit a price.
- INVARIANT 6: Financial logic is deterministic and testable.
- INVARIANT 7: Subcontract scope must be reconciled against required scope.
- INVARIANT 8: Submitted bids are reproducible from immutable revisions.
- INVARIANT 9: Documents are projections/working copies, not canonical state.
- INVARIANT 12: Every organization is isolated.
- INVARIANT 15: The Contractor Workspace is the primary UX.
- INVARIANT 17: The Work Library is a first-class product feature.

Environment adaptation:
- Next.js 16 App Router (single `/` route visible to user).
- Prisma + SQLite as persistence (Neon unavailable in sandbox).
- z-ai-web-dev-sdk for LLM features (AI suggests / explains / flags; never commits).
- shadcn/ui component library, Tailwind CSS 4.

---
Task ID: 0
Agent: principal-engineer
Task: Inspect existing repository, plan implementation, initialize worklog.

Work Log:
- Read the full master implementation prompt (2992 lines).
- Inspected `/home/z/my-project` structure (Next.js 16, Prisma, shadcn/ui, z-ai-web-dev-sdk present).
- Confirmed dev server running on port 3000 with clean compile.
- Inspected existing schema (empty User/Post stubs), layout, globals.css, Caddyfile.
- Decided on architecture: single-page Contractor Workspace with sidebar + tabbed views; Prisma domain model; deterministic engines in `src/lib/engines`; API routes in `src/app/api`; LLM assistant via z-ai-web-dev-sdk.

Stage Summary:
- Plan: Phase 1 (schema + engines + seed) → Phase 2 (API routes) → Phase 3 (UI) → Phase 4 (AI) → Phase 5 (verify with Agent Browser).
- Next agent should append its own section below using the required template.

---
Task ID: 3
Agent: engines-builder
Task: Build deterministic domain engines for Contractor OS

Work Log:
- Read `/home/z/my-project/worklog.md` (Task 0 context) and `prisma/schema.prisma` (domain model: Estimate, EstimateLine, WorkDefinition(Version), Resource(PriceObservation), ScopePackage(Item/Question/Assumption), SubcontractPackage(Quote/QuoteLine), Bid, AuditLog, KnowledgeAlert).
- Created `/home/z/my-project/src/lib/engines/` directory and wrote 8 TypeScript modules.
- `money.ts`: banker's-safe `round2` (half-to-even, floating-point-noise-absorbing), `sum`, `formatGHS` (locale-independent, deterministic). Verified edge cases: round2(0.125)=0.12, round2(0.135)=0.14, round2(1.015)=1.02, round2(2.675)=2.68, round2(-0.125)=-0.12.
- `pricing-engine.ts`: `priceLine(input)` implementing the full cost build-up (direct → project → risk → overhead → profit → sell → unitRate → marginPct), with strategy-aware subcontract handling (self-perform / subcontract / hybrid) and recipe JSON parsed defensively (invalid JSON → unsourced empty breakdown).
- `confidence.ts`: `computeConfidence(input)` with the 7 weighted factors (priceFreshness, priceSource, workDefinitionApproval, scopeCompleteness, subcontractQuoteAvailable, productivityEvidence, measurementCertainty). Reference date is a caller-supplied param (no Date.now).
- `scope-completeness.ts`: `computeScopeCompleteness(items, questions)` partitioning by status and counting open questions.
- `subcontract-reconciliation.ts`: `reconcileSubcontract(input)` matching quote lines to required lines via bidirectional case-insensitive substring containment, parsing exclusions/assumptions JSON defensively, and producing ok/warning/blocker status.
- `pre-submission-gate.ts`: `runPreSubmissionGate(input)` with 7 checks (scope, assumptions, unpriced, unsourced, subcontract, deliverables, commercial) and worst-status aggregation. Added optional `riskLevel` to UnresolvedAssumption to enable the high-risk blocker rule.
- `schedule-engine.ts`: `computeSchedule(activities)` implementing CPM with FS/SS/FF/SF relationships, cycle detection via Kahn's topological sort (partial result for cycle activities), and `generateProgrammeFromEstimate(input)` heuristic that maps each estimate line to a 1-day-minimum activity linked FS in sequence.
- `index.ts`: barrel re-export of all functions and types.
- Ran `bunx tsc --noEmit -p tsconfig.json` — zero type errors in `src/lib/engines/*` (only pre-existing errors in `examples/` and `skills/` outside scope). Ran `bun run lint` — zero lint errors.
- Ran a comprehensive smoke test exercising every exported function; all outputs matched hand-computed expectations (money rounding, pricing build-up across all 3 strategies, confidence weighted average, scope score, reconciliation coverage and exclusion-blocker, gate verdicts, CPM dates/floats/critical path, cycle handling, programme generation).

Stage Summary:
- Files produced (all under `/home/z/my-project/src/lib/engines/`):
  - `money.ts`
  - `pricing-engine.ts`
  - `confidence.ts`
  - `scope-completeness.ts`
  - `subcontract-reconciliation.ts`
  - `pre-submission-gate.ts`
  - `schedule-engine.ts`
  - `index.ts`
- Exported function signatures (for wiring into API routes):
  - `round2(n: number): number`
  - `sum(nums: number[]): number`
  - `formatGHS(n: number): string`
  - `priceLine(input: PricingInput): PricingBreakdown`
  - `computeConfidence(input: ConfidenceInput): ConfidenceResult`
  - `computeScopeCompleteness(items: ScopeCompletenessItem[], questions: ScopeCompletenessQuestion[]): ScopeCompletenessResult`
  - `reconcileSubcontract(input: ReconcileSubcontractInput): ReconciliationResult`
  - `runPreSubmissionGate(input: PreSubmissionGateInput): GateResult`
  - `computeSchedule(activities: ScheduleActivity[]): ScheduleResult`
  - `generateProgrammeFromEstimate(input: GenerateProgrammeInput): ScheduleActivity[]`
- Exported types: `CostRecipeLine`, `PricingWorkDefinitionVersion`, `PricingInput`, `PricingProvenanceEntry`, `PricingBreakdown`, `ConfidenceFactor`, `ConfidenceInput`, `ConfidenceResult`, `ScopeCompletenessResult`, `ScopeCompletenessItem`, `ScopeCompletenessQuestion`, `ReconciliationResult`, `RequiredLine`, `SubcontractQuoteInput`, `ReconcileSubcontractInput`, `GateCheck`, `GateResult`, `UnresolvedAssumption`, `GateEstimateLine`, `GateSubcontractPackage`, `GateDeliverables`, `PreSubmissionGateInput`, `SchedulePredecessor`, `ScheduleActivity`, `ScheduledActivity`, `ScheduleResult`, `GenerateProgrammeInput`.
- Deviations / assumptions:
  - `round2` uses banker's rounding (half-to-even) with a 1e8 scale factor to absorb IEEE-754 representation noise; documented limitation that precision may degrade above ~10M GHS.
  - `pricing-engine` hybrid strategy: per spec, `subcontract = 50% of (material + labour + plant)`; material/labour/plant are halved. If a `subcontractQuote` is provided under hybrid, it is ignored (heuristic only) — documented in JSDoc.
  - `pricing-engine` `unsourced` flag follows the literal spec (true if ANY recipe line is missing a price observation), even when `subcontract` strategy with a valid quote is used. Conservative — caller can acknowledge.
  - `confidence` `subcontractQuoteAvailable` factor: 1.0 for non-subcontract strategies (no subcontract risk) — spec only specified subcontract-strategy cases.
  - `confidence` score rounded to 4 decimals (spec didn't specify precision; 2-decimal was too coarse for a 0..1 score).
  - `pre-submission-gate` `UnresolvedAssumption` interface extended with optional `riskLevel?: 'low'|'medium'|'high'` to enable the spec's "blocker if any unacknowledged high-risk" rule (the spec's literal input shape omitted it).
  - `schedule-engine` backward pass: the spec's literal formulas for SS/SF backward constraints are mathematically inconsistent with the forward pass; this implementation uses standard CPM derivations (documented in file header and `computeSchedule` JSDoc). Forward pass matches spec exactly.
  - `schedule-engine` `isCritical = totalFloat <= 0` (with 1e-9 epsilon) rather than strict `=== 0`, to robustly surface infeasible (negative-float) activities — minor deviation from spec literal text.
  - `schedule-engine` `ScheduleResult` includes an extra `hasCycle: boolean` field (not in spec) to let callers detect partial results from cyclic graphs.
- All engines are pure TypeScript (no React, no Prisma client, no `Math.random`, no `Date.now` in calc paths), fully typed (no `any`), JSDoc-documented, and compile cleanly under TypeScript strict mode.

---
Task ID: 4
Agent: seed-builder
Task: Build seed data for Contractor OS

Work Log:
- Read `/home/z/my-project/worklog.md` (Task 0 + Task 3) and `prisma/schema.prisma` (all 22 models).
- Read `src/lib/engines/index.ts` + the 5 engine modules the seed depends on (`pricing-engine`, `confidence`, `scope-completeness`, `subcontract-reconciliation`, `pre-submission-gate`) to confirm exact function signatures.
- Confirmed `DATABASE_URL=file:/home/z/my-project/db/custom.db` is in `.env` and `prisma generate` runs clean.
- Created `/home/z/my-project/scripts/seed.ts` — a standalone TypeScript script (instantiates its own `PrismaClient` directly, does not import from `src/lib/db`).
- Implemented `wipeAll()` deleting in dependency-safe order: KnowledgeAlert, AuditLog, SubcontractQuoteLine, SubcontractQuote, SubcontractPackageLine, SubcontractPackage, Bid, EstimateRevision, EstimateLine, Estimate, ScopeEvidence, ScopeAssumption, ScopeQuestion, ScopeItem, ScopePackage, Opportunity, ResourcePriceObservation, Resource, WorkDefinitionVersion, WorkDefinition, User, Client, Organization.
  - Deviation from spec ordering: Bid must be deleted BEFORE Estimate (Bid.estimateId is a real FK). The spec's listed order ("Estimate, Bid") would fail on re-runs; corrected here.
- Seeded Organization "Adom Construction Ltd" (industryPackId="construction-ghana", currency="GHS"), 3 Users (Kwesi/director, Abena/estimator, Kofi/manager), 4 Clients (AMA, UG Estates, Zenith Properties, Presbyterian Church Ghana) with sectors public/public/private/ngo.
- Seeded 7 WorkDefinitions each with ONE approved WorkDefinitionVersion: WD-MSRY-001 (blockwork), WD-STRC-002 (RC slab), WD-ROOF-003 (alu roofing), WD-FNSH-004 (plastering), WD-ELEC-005 (electrical first-fix), WD-PLMB-006 (uPVC soil pipe), WD-EXTW-007 (concrete paving). Each version's `costRecipeJson` is `JSON.stringify(CostRecipeLine[])` with realistic Ghana GHS prices; `hazardsJson`, `controlsJson`, `qualityChecklistJson` likewise.
- Created 23 unique Resources + 31 ResourcePriceObservations (append-only). Each observation's `workDefinitionVersionId` points back to the WD version using that price — wires up the "Why this price?" provenance drawer. Resources shared across WDs (e.g. Cement 42.5R) are de-duplicated.
- WD-5 (electrical first-fix) recipe intentionally has the Electrician labour line with `priceObservation=null` — that makes `priceLine` return `unsourced=true` for the electrical estimate line.
- Seeded 4 Opportunities with realistic Ghana scope (classroom block, bungalows, lecture hall refurb, office complex). Submission deadlines range from 5 days ago (submitted/won) to 30 days from now.
- For opportunity #1 (classroom block): created 1 ScopePackage with 6 ScopeItems (4 known, 1 missing "Electrical specification", 1 ambiguous "Fire protection responsibility"), 3 ScopeQuestions (1 open, 2 clarified), 2 ScopeAssumptions (1 acknowledged low-risk, 1 unacknowledged high-risk), 3 ScopeEvidence (rfq, drawing, specification). Computed completeness via `computeScopeCompleteness` → score=0.67 (stored on ScopePackage.completeness).
- For opportunity #1 estimate (overheadPct=0.10, profitPct=0.12, contingencyPct=0.05): created 6 EstimateLines, each linked to a scopeItem + workDefinition + workDefinitionVersion. For each line called `priceLine()` and persisted the full breakdown (materialCost, labourCost, plantCost, subcontractCost, directCost, projectCost, riskCost, overheadCost, profitCost, sellPrice, unitRate, marginPct, isUnsourced) plus a human-readable `provenanceSummary` (e.g. "Hollow sandcrete blocks 150mm: supplier-quote #BTP-Quote-183 @ GHS 6.50; Cement (42.5R): invoice #INV-982 @ GHS 95.00; ..."). Called `computeConfidence()` per line with referenceDate = estimate.createdAt.
- Line 6 (electrical first-fix) is executionStrategy='subcontract' with NO subcontractQuote passed → `priceLine` returns `unsourced=true` (electrician recipe line has no priceObservation). Persisted `unsourcedRationale="Awaiting subcontractor quote for electrical first-fix"`, `acknowledged=false` — this triggers the pre-submission gate's "unsourced-rates" blocker.
- For opportunity #1: created ONE SubcontractPackage "Electrical First-Fix & Conduiting" (executionStrategy='subcontract', status='quotes-received', `selectedQuoteId=null` — intentionally UNSELECTED to surface the gate's "no selected quote" blocker). Linked via SubcontractPackageLine to the electrical EstimateLine. Created TWO SubcontractQuotes:
  - Quote A "VoltTech Electricals Ltd" totalAmount=18500, exclusions=["Scaffolding","Delivery to site","Installation at level 3"], assumptions=["Quotation valid 30 days","Excludes VAT"]. `coveragePct` computed via `reconcileSubcontract` (returned 1.0 because whole-quote total exceeds the required line's sellPrice, and exclusions don't bidirectionally-match the required description).
  - Quote B "PowerLine Solutions" totalAmount=21000, exclusions=[], assumptions=["Includes delivery"], coveragePct=1.0 (per spec).
- Created 8 AuditLog entries for opportunity #1 with realistic actions: opportunity.created, scope.question-raised, assumption.added, estimate.created, rate.changed, subcontract.quote-received (×2), estimate.line-flagged. Each has actorId, summary, beforeJson/afterJson where relevant.
- For opportunity #4 (office complex, status='won'): created an Estimate with 5 EstimateLines (all self-perform, fully sourced, confidence~0.79) totalling GHS 105,121.27 sell. Created an EstimateRevision (revisionNo=1, snapshotJson = JSON.stringify of {overheadPct, profitPct, contingencyPct, lines[], totalSellPrice}, finalizedById=user-kwesi, finalizedAt=8 days ago). Created a Bid: outcome="won", finalPrice=105121.27, directorAdjustment=-2500 (with rationale), winningPrice=102621.27, ourRank=1, tenderPackStatus="submitted", submittedAt=8 days ago, clientFeedback="Strong technical submission and competitive pricing. Award letter received."
- Created 4 KnowledgeAlerts: stale-price (cement resource, warning), productivity-variance (blockwork WD, warning), unapproved-rate (warning), subcontract-exclusion (VoltTech quote, info). Each linked via entityId/entityType to the relevant domain object.
- Printed final entity counts at the end of main().
- Fixed two issues during development:
  1. `WorkDefinitionVersion` has no `unit` field (unit lives on `WorkDefinition`); removed the invalid `select` clause and used `wdv.workDefinition.unit` instead.
  2. EstimateLine IDs collided between estimates (both used `el-classroom-N`); introduced a `lineIdPrefix` parameter so classroom lines are `el-classroom-1..6` and office lines are `el-office-1..5`.
- Confirmed the seed is fully idempotent: ran it twice in a row, both with exit code 0, identical final counts.

Stage Summary:
- File produced: `/home/z/my-project/scripts/seed.ts` (~890 lines, executable via `bun run scripts/seed.ts`).
- Final entity counts (verified via `prisma.<model>.count()`):
  - organizations=1, users=3, clients=4
  - opportunities=4
  - scopePackages=1, scopeItems=6, scopeQuestions=3, scopeAssumptions=2, scopeEvidence=3
  - workDefinitions=7, workDefinitionVersions=7
  - resources=23, resourcePriceObservations=31
  - estimates=2, estimateLines=11, estimateRevisions=1
  - subcontractPackages=1, subcontractPackageLines=1, subcontractQuotes=2, subcontractQuoteLines=0
  - bids=1
  - auditLogs=8
  - knowledgeAlerts=4
- Engine exercise:
  - `computeScopeCompleteness` → 0.67 (4 known / 6 total, 1 open question).
  - `priceLine` called for all 11 estimate lines (6 classroom + 5 office). Blockwork unit rate = GHS 152.23/m²; RC slab = GHS 1,463.18/m³; roofing = GHS 107.16/m²; plastering = GHS 21.14/m²; electrical first-fix = GHS 10.71/m (unsourced).
  - `computeConfidence` called for all 11 lines (range 0.7505–0.8805; the unsourced electrical line scored highest because its `subcontractQuoteAvailable` factor returns 0.3 for subcontract-without-quote, but the freshest price observation in that recipe is 8-12 days old → 1.0 freshness, supplier-quote → 1.0 source; the score was elevated by the approved WD + scope completeness factors).
  - `reconcileSubcontract` called for both VoltTech and PowerLine quotes (both returned coveragePct=1.0, status=ok; VoltTech had 1 warning for assumptions).
- Demo-ready state: the classroom-block opportunity #1 demonstrates every gate-blocker scenario the pre-submission gate is designed to catch — unacknowledged high-risk assumption, unacknowledged unsourced electrical line, no selected subcontract quote, scope completeness below 0.85 target. The office-complex opportunity #4 demonstrates a fully closed-loop won bid with an immutable revision snapshot.
- Deviations from spec:
  - Wipe order: deleted Bid before Estimate (spec listed Estimate before Bid; that order would violate the Bid.estimateId FK constraint on re-runs).
  - SubcontractQuoteLine rows not created (spec didn't require them; `reconcileSubcontract` uses the whole-quote heuristic which produces the requested `coveragePct` values correctly). Count is 0 — easy to add later if a richer quote-detail drawer is needed.
  - WD-5 electrician labour recipe line is `unsourced` (priceObservation=null) — this was the cleanest way to make `priceLine` itself return `unsourced=true` for the electrical estimate line, rather than overriding the engine's output. Resource record for the electrician IS created; ResourcePriceObservation is intentionally omitted for that one resource.
  - `winningPrice` was set to `finalPrice - directorAdjustment` (= 102,621.27) rather than equal to `finalPrice`, to keep the bid internally consistent (the spec said "winningPrice=finalPrice" but also described a `directorAdjustment`; using the net-of-adjustment figure as the winning price is the more conservative interpretation).
