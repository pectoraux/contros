'use client'

import { useEffect, useRef, useState } from 'react'
import { useWorkspace } from '@/store/workspace'
import { apiPost, type AiAssistantResponse } from '@/lib/api'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Sparkles, Send, Loader2, AlertTriangle, X } from 'lucide-react'
import { toast } from 'sonner'

type SkillId = 'general' | 'identify-gaps' | 'explain-rate' | 'draft-clarification' | 'tender-readiness'

const SKILLS: { id: SkillId; label: string; hint: string }[] = [
  { id: 'general', label: 'General', hint: 'Ask anything about the opportunity' },
  { id: 'identify-gaps', label: 'Identify Gaps', hint: 'What scope is missing or ambiguous?' },
  { id: 'explain-rate', label: 'Explain Rate', hint: 'Why is this price what it is?' },
  { id: 'draft-clarification', label: 'Draft Clarification', hint: 'Compose a client query' },
  { id: 'tender-readiness', label: 'Tender Readiness', hint: 'Are we ready to submit?' },
]

const SUGGESTIONS: Record<SkillId, string[]> = {
  general: [
    'Summarize the commercial position of this opportunity',
    'What are the biggest risks in this estimate?',
    'Which lines have the lowest confidence?',
  ],
  'identify-gaps': [
    'What scope is missing from the RFQ?',
    'Which ambiguities have the highest commercial impact?',
    'What questions should I ask the client?',
  ],
  'explain-rate': [
    'Walk me through how this unit rate was computed',
    'Which resources are unsourced and why?',
    'How fresh are the price observations behind this rate?',
  ],
  'draft-clarification': [
    'Draft a clarification email about the ambiguous roof specification',
    'Draft a clarification about fire protection responsibility',
  ],
  'tender-readiness': [
    'Are we ready to submit this bid?',
    'What blockers must be resolved before tender pack generation?',
  ],
}

export function AiAssistantPanel() {
  const open = useWorkspace((s) => s.aiPanelOpen)
  const closeAiPanel = useWorkspace((s) => s.closeAiPanel)
  const skill = useWorkspace((s) => s.aiSkill) as SkillId
  const targetLineId = useWorkspace((s) => s.aiTargetLineId)
  const opportunityId = useWorkspace((s) => s.opportunityId)

  const [question, setQuestion] = useState('')
  const [response, setResponse] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fallback, setFallback] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setResponse(null)
      setError(null)
      setFallback(null)
      setQuestion('')
    }
  }, [open, skill, targetLineId])

  async function ask(q?: string) {
    const query = q ?? question
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    setFallback(null)
    setResponse(null)
    try {
      const result = await apiPost<AiAssistantResponse>('/api/ai-assistant', {
        skill,
        question: query,
        opportunityId,
        estimateLineId: targetLineId,
      })
      if (result.error) {
        setError(result.detail ?? result.error)
        setFallback(result.fallback ?? null)
      } else {
        setResponse(result.response)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
      toast.error('AI assistant request failed')
    } finally {
      setLoading(false)
      setTimeout(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
        }
      }, 100)
    }
  }

  function setSkill(s: SkillId) {
    useWorkspace.setState({ aiSkill: s })
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && closeAiPanel()}>
      <SheetContent className="w-full sm:max-w-lg flex flex-col p-0 gap-0">
        <SheetHeader className="px-4 py-3 border-b border-border space-y-1">
          <div className="flex items-center justify-between">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4" />
              Contractor AI Assistant
            </SheetTitle>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={closeAiPanel}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <SheetDescription className="text-xs">
            Advisory only · cannot commit prices · operates over the canonical domain model
          </SheetDescription>
        </SheetHeader>

        {/* Skill selector */}
        <div className="px-4 py-2 border-b border-border">
          <div className="flex flex-wrap gap-1">
            {SKILLS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSkill(s.id)}
                className={`text-[11px] px-2 py-1 rounded-md border transition-colors ${
                  skill === s.id
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:bg-muted'
                }`}
                title={s.hint}
              >
                {s.label}
              </button>
            ))}
          </div>
          {targetLineId && (
            <div className="mt-2 text-[11px] text-amber-700 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              Targeting estimate line — explain-rate skill uses its full provenance
            </div>
          )}
        </div>

        {/* Conversation */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {!response && !loading && !error && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {SKILLS.find((s) => s.id === skill)?.hint}
              </p>
              <div className="space-y-1">
                {(SUGGESTIONS[skill] ?? []).map((s) => (
                  <button
                    key={s}
                    onClick={() => ask(s)}
                    className="block w-full text-left text-xs p-2 rounded-md border border-border hover:bg-muted transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Analyzing domain context...
            </div>
          )}

          {error && (
            <div className="p-3 rounded-md bg-red-50 border border-red-200">
              <div className="flex items-center gap-2 text-sm font-medium text-red-700 mb-1">
                <AlertTriangle className="h-4 w-4" />
                AI unavailable
              </div>
              <p className="text-xs text-red-600">{error}</p>
              {fallback && <p className="text-xs text-muted-foreground mt-2">{fallback}</p>}
            </div>
          )}

          {response && !loading && (
            <div className="space-y-2">
              <div className="p-3 rounded-md bg-muted/50 border border-border">
                <p className="text-xs text-muted-foreground mb-1">Response</p>
                <div className="text-sm leading-relaxed whitespace-pre-wrap">{response}</div>
              </div>
              <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">
                Advisory only — prices committed exclusively by the deterministic pricing engine
              </Badge>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="p-3 border-t border-border space-y-2">
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={`Ask the assistant... (${skill})`}
            className="text-sm resize-none"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                ask()
              }
            }}
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">⌘+Enter to send</span>
            <Button size="sm" className="gap-2" onClick={() => ask()} disabled={loading || !question.trim()}>
              <Send className="h-3.5 w-3.5" />
              Send
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
