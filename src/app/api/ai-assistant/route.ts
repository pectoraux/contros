import { NextResponse } from 'next/server'
import { getZAI } from '@/lib/zai'
import { db } from '@/lib/db'

// Contractor AI Assistant
// INVARIANT 5: AI cannot silently commit a price.
// The AI may: read, extract, search, classify, suggest, draft, compare, explain, flag.
// The AI may NOT: bypass pricing service, commit prices, bypass approval/audit.
// All write tools validate inputs through domain services — the AI has NO write tools here.

const SYSTEM_PROMPT = `You are the Contractor OS assistant for a Ghana-based construction SME (currency: GHS).
You operate OVER the canonical domain model — you are NOT the domain model itself.

You may:
- read, extract, classify, summarize the provided domain context
- suggest, compare, explain, flag, draft
- recommend questions to ask the client or site team
- draft clarifications, method statement fragments, assumption text

You may NOT:
- invent or commit a live bid price (all committed prices come from the deterministic pricing engine)
- claim a price is "correct" without citing the provenance provided in context
- bypass approval workflows, audit, or revision mechanisms
- fabricate work definitions, resource prices, or productivity figures

When you don't have enough context, say so explicitly and recommend what to obtain.
Be concise, professional, and information-dense. Use short paragraphs and bullet points.
When citing a price, always reference its provenance (supplier quote #, invoice #, etc.) if available in context.
If asked to "price" something, explain that pricing is deterministic and recommend running the pricing engine on a linked WorkDefinition — never output a number as the committed price.`

interface AssistantRequest {
  skill?: 'explain-rate' | 'identify-gaps' | 'draft-clarification' | 'tender-readiness' | 'general'
  question: string
  opportunityId?: string
  estimateLineId?: string
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as AssistantRequest
  const { skill = 'general', question, opportunityId, estimateLineId } = body

  if (!question) {
    return NextResponse.json({ error: 'question required' }, { status: 400 })
  }

  // Build deterministic domain context for the AI (read-only)
  let contextBlock = ''
  if (opportunityId) {
    const opp = await db.opportunity.findUnique({
      where: { id: opportunityId },
      include: {
        client: true,
        scopePackage: { include: { items: true, questions: true, assumptions: true, evidence: true } },
        estimates: {
          include: {
            lines: {
              include: {
                workDefinition: true,
                workDefinitionVersion: { include: { priceObservations: true } },
                scopeItem: true,
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
        subcontractPackages: { include: { lines: true, quotes: true } },
        bid: true,
      },
    })
    if (!opp) {
      return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })
    }

    const estimate = opp.estimates[0]
    const scopePkg = opp.scopePackage

    const linesBlock = estimate
      ? estimate.lines
          .map((l) => {
            const wdv = l.workDefinitionVersion
            const recipe = wdv ? JSON.parse(wdv.costRecipeJson || '[]') : []
            const provenance = wdv?.priceObservations?.length
              ? wdv.priceObservations
                  .map((p) => `${p.provenance}${p.sourceReference ? ` #${p.sourceReference}` : ''} @ GHS ${p.price} (${new Date(p.observedAt).toLocaleDateString()})`)
                  .join('; ')
              : 'UNSOURCED'
            return `- Line ${l.id}: "${l.description}" — qty ${l.quantity} ${l.unit}, strategy ${l.executionStrategy}
    WorkDefinition: ${l.workDefinition ? `${l.workDefinition.code} v${wdv?.version} (${wdv?.approvalState})` : 'NONE'}
    Unit rate: GHS ${l.unitRate.toFixed(2)}/${l.unit}, sell price: GHS ${l.sellPrice.toFixed(2)}, margin ${(l.marginPct * 100).toFixed(1)}%, confidence ${(l.confidence * 100).toFixed(0)}%
    Unsourced: ${l.isUnsourced ? `YES — ${l.unsourcedRationale ?? 'no rationale'}` : 'no'}
    Provenance: ${provenance}
    Recipe: ${recipe.length} resource lines`
          })
          .join('\n')
      : 'No estimate yet.'

    const scopeBlock = scopePkg
      ? `Completeness: ${(scopePkg.completeness * 100).toFixed(0)}%
Items:
${scopePkg.items.map((i) => `  - [${i.status}] ${i.description} (${i.category || 'no category'})`).join('\n')}
Open questions:
${scopePkg.questions.map((q) => `  - [${q.status}] ${q.question}`).join('\n')}
Assumptions:
${scopePkg.assumptions.map((a) => `  - [${a.riskLevel}${a.acknowledged ? ', ack' : ', UNACK'}] ${a.text}`).join('\n')}
Evidence:
${scopePkg.evidence.map((e) => `  - [${e.type}] ${e.summary}${e.reference ? ` (${e.reference})` : ''}`).join('\n')}`
      : 'No scope package yet.'

    const subcontractBlock = opp.subcontractPackages.length
      ? opp.subcontractPackages
          .map((sp) => {
            const quotes = sp.quotes
              .map((q) => `    - ${q.supplierName}: GHS ${q.totalAmount} (coverage ${(q.coveragePct * 100).toFixed(0)}%, exclusions: ${JSON.parse(q.exclusionsJson || '[]').join(', ') || 'none'})${sp.selectedQuoteId === q.id ? ' [SELECTED]' : ''}`)
              .join('\n')
            return `  Package: ${sp.name} (${sp.executionStrategy}, status ${sp.status})
${quotes}`
          })
          .join('\n')
      : 'No subcontract packages.'

    contextBlock = `OPPORTUNITY CONTEXT (read-only, deterministic):
Title: ${opp.title}
Client: ${opp.client.name} (${opp.client.sector})
Status: ${opp.status}
Location: ${opp.location || 'unspecified'}
Submission deadline: ${opp.submissionDeadline ? new Date(opp.submissionDeadline).toLocaleDateString() : 'unspecified'}

SCOPE PACKAGE:
${scopeBlock}

ESTIMATE (latest): ${estimate ? `${estimate.status}, overhead ${(estimate.overheadPct * 100).toFixed(0)}%, profit ${(estimate.profitPct * 100).toFixed(0)}%, contingency ${(estimate.contingencyPct * 100).toFixed(0)}%` : 'none'}
${linesBlock}

SUBCONTRACT PACKAGES:
${subcontractBlock}

BID: ${opp.bid ? `${opp.bid.tenderPackStatus}, outcome ${opp.bid.outcome ?? 'pending'}` : 'none'}`
  } else {
    contextBlock = 'No specific opportunity context provided. Answer generally and recommend opening an opportunity for detailed analysis.'
  }

  // If a specific estimate line is targeted, fetch full provenance
  let lineContext = ''
  if (estimateLineId) {
    const line = await db.estimateLine.findUnique({
      where: { id: estimateLineId },
      include: {
        workDefinition: true,
        workDefinitionVersion: { include: { priceObservations: { include: { resource: true } } } },
        scopeItem: true,
        estimate: { include: { opportunity: true } },
      },
    })
    if (line) {
      const wdv = line.workDefinitionVersion
      const recipe = wdv ? JSON.parse(wdv.costRecipeJson || '[]') : []
      lineContext = `\n\nTARGETED ESTIMATE LINE (for explain-rate skill):
Description: ${line.description}
Quantity: ${line.quantity} ${line.unit}
Strategy: ${line.executionStrategy}
Unit rate: GHS ${line.unitRate.toFixed(2)}, Sell price: GHS ${line.sellPrice.toFixed(2)}, Margin ${(line.marginPct * 100).toFixed(1)}%
Confidence: ${(line.confidence * 100).toFixed(0)}%
Unsourced: ${line.isUnsourced ? `YES — ${line.unsourcedRationale}` : 'no'}
Provenance summary: ${line.provenanceSummary}

WorkDefinition: ${line.workDefinition ? `${line.workDefinition.code} ${line.workDefinition.name}` : 'NONE'}
Version: v${wdv?.version} (${wdv?.approvalState}), productivity ${wdv?.productivityRule ?? 'n/a'} ${line.unit}/crew-day, wastage ${((wdv?.wastage ?? 0) * 100).toFixed(0)}%
Cost recipe:
${recipe.map((r: { resourceKind: string; resourceCode: string; resourceName: string; unit: string; quantityPerUnit: number; priceObservation: { price: number; provenance: string; sourceReference?: string; observedAt: string } | null }) => `  - [${r.resourceKind}] ${r.resourceName} (${r.resourceCode}): ${r.quantityPerUnit} ${r.unit}/unit${r.priceObservation ? ` @ GHS ${r.priceObservation.price} [${r.priceObservation.provenance}${r.priceObservation.sourceReference ? ` #${r.priceObservation.sourceReference}` : ''}, ${new Date(r.priceObservation.observedAt).toLocaleDateString()}]` : ' [NO PRICE — UNSOURCED]'}`).join('\n')}

Linked scope item: ${line.scopeItem ? `[${line.scopeItem.status}] ${line.scopeItem.description}` : 'none'}`
    }
  }

  // Skill-specific user prompt suffix
  const skillInstructions: Record<string, string> = {
    'explain-rate': `\n\nThe user is asking about a specific rate. Use the TARGETED ESTIMATE LINE context above. Explain WHY the unit rate is GHS ${estimateLineId ? '' : ''}what it is by walking through the cost recipe, resource prices, provenance (supplier quote #, invoice #), wastage, overhead, profit, and contingency. Never invent a price. If the line is unsourced, explain which resources lack price observations and recommend obtaining supplier quotations.`,
    'identify-gaps': `\n\nThe user wants to know what scope is missing or ambiguous. Use the SCOPE PACKAGE context. List the missing and ambiguous items, rank them by commercial impact where possible, and recommend: (a) what question to ask the client, (b) what evidence to obtain, (c) what assumption to record. Reference the open ScopeQuestions.`,
    'draft-clarification': `\n\nThe user wants a draft clarification to send to the client. Use the SCOPE PACKAGE context (especially open questions and ambiguous items). Draft a professional, concise clarification email in plain text. Sign off as the estimating team. Do not commit to a price.`,
    'tender-readiness': `\n\nThe user wants to know if they are ready to submit. Summarize: scope completeness, unresolved assumptions, unsourced lines, subcontract coverage gaps, and missing deliverables. Recommend the next concrete actions. Do not override the pre-submission gate — defer to it for the verdict.`,
    'general': '',
  }

  const userMessage = `${contextBlock}${lineContext}${skillInstructions[skill] || ''}

USER QUESTION:
${question}`

  try {
    const zai = await getZAI()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      thinking: { type: 'disabled' },
    })

    const response = completion.choices[0]?.message?.content ?? ''

    // Audit the AI interaction (read-only — no domain mutation)
    if (opportunityId) {
      const opp = await db.opportunity.findUnique({ where: { id: opportunityId } })
      if (opp) {
        await db.auditLog.create({
          data: {
            organizationId: opp.organizationId,
            action: 'ai.assistant-queried',
            entityType: 'Opportunity',
            entityId: opp.id,
            summary: `AI skill "${skill}": ${question.slice(0, 100)}`,
          },
        })
      }
    }

    return NextResponse.json({
      response,
      skill,
      context: {
        opportunityId: opportunityId ?? null,
        estimateLineId: estimateLineId ?? null,
        warning: 'AI output is advisory only. Prices are committed exclusively by the deterministic pricing engine.',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown AI error'
    return NextResponse.json(
      {
        error: 'AI assistant unavailable',
        detail: message,
        // Application must still function without AI (INVARIANT: deterministic estimating works without AI).
        fallback: 'The AI assistant is currently unavailable. All deterministic estimating, scope, and pre-submission features continue to work normally.',
      },
      { status: 503 },
    )
  }
}
