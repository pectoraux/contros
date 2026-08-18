'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Info, Loader2, Ruler, Link2, FileText, Layers, Clock, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { OpportunityDetail } from '@/lib/api'
import type { MeasurementMethod } from '@/lib/plan'

interface PlanArtifactView {
  id: string
  fileName: string
  fileHash: string
  source: string
  sheets?: PlanSheetView[]
}

interface PlanSheetView {
  id: string
  sheetNumber: string
  drawingNumber: string | null
  title: string | null
  revisions?: PlanSheetRevisionView[]
}

interface PlanSheetRevisionView {
  id: string
  revision: string
  createdAt: string
  measurements?: PlanMeasurementView[]
}

interface PlanMeasurementView {
  id: string
  elementReference: string | null
  measurementMethod: string
  quantity: number
  unit: string
  measurementBasisJson: string
  contentHash: string
  estimateLines?: { id: string; description: string }[]
}

interface EstimateLineOption {
  id: string
  description: string
  unit: string
  quantity: number
}

const MEASUREMENT_METHODS: { value: MeasurementMethod; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'pdf-takeoff', label: 'PDF Takeoff' },
  { value: 'cad-extraction', label: 'CAD Extraction' },
  { value: 'bim-export', label: 'BIM Export' },
  { value: 'ai-extraction', label: 'AI Extraction' },
]

const SOURCES = ['client', 'consultant', 'tender-portal', 'internal', 'other']

export function PlanTab({ opp }: { opp: OpportunityDetail }) {
  const [artifacts, setArtifacts] = useState<PlanArtifactView[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)

  // Upload form state
  const [fileName, setFileName] = useState('')
  const [fileHash, setFileHash] = useState('')
  const [source, setSource] = useState('consultant')
  const [uploading, setUploading] = useState(false)

  // Sheet creation state
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [sheetNumber, setSheetNumber] = useState('')
  const [sheetTitle, setSheetTitle] = useState('')
  const [creatingSheet, setCreatingSheet] = useState(false)

  // Revision creation state
  const [selectedSheetId, setSelectedSheetId] = useState<string | null>(null)
  const [revisionName, setRevisionName] = useState('')
  const [creatingRevision, setCreatingRevision] = useState(false)

  // Measurement creation state
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null)
  const [elementRef, setElementRef] = useState('')
  const [method, setMethod] = useState<MeasurementMethod>('manual')
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState('m2')
  const [basisJson, setBasisJson] = useState('{}')
  const [creatingMeasurement, setCreatingMeasurement] = useState(false)

  // EstimateLine linking state
  const [estimateLines, setEstimateLines] = useState<EstimateLineOption[]>([])
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)

  const fetchArtifacts = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/plan/artifacts?opportunityId=${opp.id}`)
      if (res.ok) {
        const data = await res.json()
        setArtifacts(data.artifacts || [])
      }
    } catch {
      // non-fatal
    } finally {
      setLoading(false)
    }
  }, [opp.id])

  useEffect(() => {
    fetchArtifacts()
  }, [fetchArtifacts, refreshKey])

  // Fetch estimate lines for this opportunity (for linking)
  useEffect(() => {
    async function fetchLines() {
      try {
        const res = await fetch(`/api/opportunities/${opp.id}/estimate`)
        if (res.ok) {
          const data = await res.json()
          if (data.lines) {
            setEstimateLines(data.lines.map((l: { id: string; description: string; unit: string; quantity: number }) => ({
              id: l.id, description: l.description, unit: l.unit, quantity: l.quantity,
            })))
          }
        }
      } catch {
        // non-fatal
      }
    }
    fetchLines()
  }, [opp.id])

  const handleUpload = async () => {
    if (!fileName || !fileHash) {
      toast.error('File name and file hash are required.')
      return
    }
    setUploading(true)
    try {
      const res = await fetch('/api/plan/artifacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunityId: opp.id,
          fileReference: `/storage/${fileName}`,
          fileName,
          fileHash,
          source,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        toast.success('Drawing registered.')
        setFileName('')
        setFileHash('')
        setRefreshKey((k) => k + 1)
      } else {
        toast.error(data.error ?? 'Could not register drawing.')
      }
    } catch {
      toast.error('Network error.')
    } finally {
      setUploading(false)
    }
  }

  const handleCreateSheet = async () => {
    if (!selectedArtifactId || !sheetNumber) {
      toast.error('Select an artifact and enter a sheet number.')
      return
    }
    setCreatingSheet(true)
    try {
      const res = await fetch(`/api/plan/artifacts/${selectedArtifactId}/sheets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetNumber, title: sheetTitle || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        toast.success('Sheet created.')
        setSheetNumber('')
        setSheetTitle('')
        setRefreshKey((k) => k + 1)
      } else {
        toast.error(data.error ?? 'Could not create sheet.')
      }
    } catch {
      toast.error('Network error.')
    } finally {
      setCreatingSheet(false)
    }
  }

  const handleCreateRevision = async () => {
    if (!selectedSheetId || !revisionName) {
      toast.error('Select a sheet and enter a revision.')
      return
    }
    setCreatingRevision(true)
    try {
      const res = await fetch(`/api/plan/sheets/${selectedSheetId}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: revisionName }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        toast.success('Revision created (immutable).')
        setRevisionName('')
        setRefreshKey((k) => k + 1)
      } else {
        toast.error(data.error ?? 'Could not create revision.')
      }
    } catch {
      toast.error('Network error.')
    } finally {
      setCreatingRevision(false)
    }
  }

  const handleCreateMeasurement = async () => {
    if (!selectedRevisionId || !quantity || !unit) {
      toast.error('Select a revision and enter quantity + unit.')
      return
    }
    setCreatingMeasurement(true)
    try {
      const res = await fetch(`/api/plan/revisions/${selectedRevisionId}/measurements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elementReference: elementRef || null,
          measurementMethod: method,
          quantity: Number(quantity),
          unit,
          measurementBasisJson: basisJson || '{}',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        toast.success('Measurement created (immutable, content-hashed).')
        setElementRef('')
        setQuantity('')
        setBasisJson('{}')
        setRefreshKey((k) => k + 1)
      } else {
        toast.error(data.error ?? 'Could not create measurement.')
      }
    } catch {
      toast.error('Network error.')
    } finally {
      setCreatingMeasurement(false)
    }
  }

  const handleLink = async () => {
    if (!selectedMeasurementId || !selectedLineId) {
      toast.error('Select a measurement and an EstimateLine.')
      return
    }
    setLinking(true)
    try {
      const res = await fetch(`/api/plan/measurements/${selectedMeasurementId}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateLineId: selectedLineId }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        toast.success('Measurement linked to EstimateLine (mutable current lineage).')
        setSelectedMeasurementId(null)
        setSelectedLineId(null)
        setRefreshKey((k) => k + 1)
      } else {
        toast.error(data.error ?? 'Could not link measurement.')
      }
    } catch {
      toast.error('Network error.')
    } finally {
      setLinking(false)
    }
  }

  // Collect all measurements from all artifacts/sheets/revisions for the linking panel
  const allMeasurements: { id: string; label: string; quantity: number; unit: string }[] = []
  for (const art of artifacts) {
    for (const sheet of art.sheets || []) {
      for (const rev of sheet.revisions || []) {
        for (const meas of rev.measurements || []) {
          allMeasurements.push({
            id: meas.id,
            label: `${art.fileName} / ${sheet.sheetNumber} / ${rev.revision} / ${meas.elementReference || 'unnamed'}`,
            quantity: meas.quantity,
            unit: meas.unit,
          })
        }
      }
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading plan workspace…
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            Upload drawing artifacts, identify sheets and revisions, create manual measurements
            (immutable evidence), and link them to EstimateLines (mutable current lineage).
            Measurements are content-addressed — same input always produces the same hash.
          </div>
        </CardContent>
      </Card>

      {/* Step 1: Register Drawing */}
      <Card>
        <CardContent className="py-4 space-y-3">
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            <FileText className="h-4 w-4" />
            1. Register Drawing Artifact
          </h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">File Name</Label>
              <Input value={fileName} onChange={(e) => setFileName(e.target.value)}
                placeholder="architectural-drawings.pdf" className="w-56 h-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">File Hash (SHA-256)</Label>
              <Input value={fileHash} onChange={(e) => setFileHash(e.target.value)}
                placeholder="abc123…" className="w-48 h-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Source</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger className="w-36 h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleUpload} disabled={uploading} size="sm" className="h-8">
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Register'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Step 2: Create Sheet */}
      {artifacts.length > 0 && (
        <Card>
          <CardContent className="py-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-1.5">
              <Layers className="h-4 w-4" />
              2. Create Sheet
            </h3>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Artifact</Label>
                <Select value={selectedArtifactId ?? ''} onValueChange={setSelectedArtifactId}>
                  <SelectTrigger className="w-64 h-8"><SelectValue placeholder="Select artifact…" /></SelectTrigger>
                  <SelectContent>
                    {artifacts.map((a) => <SelectItem key={a.id} value={a.id}>{a.fileName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Sheet Number</Label>
                <Input value={sheetNumber} onChange={(e) => setSheetNumber(e.target.value)}
                  placeholder="A-101" className="w-32 h-8" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Title (optional)</Label>
                <Input value={sheetTitle} onChange={(e) => setSheetTitle(e.target.value)}
                  placeholder="Ground Floor Plan" className="w-48 h-8" />
              </div>
              <Button onClick={handleCreateSheet} disabled={creatingSheet} size="sm" className="h-8">
                {creatingSheet ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Create Sheet'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Create Revision */}
      {artifacts.some((a) => (a.sheets || []).length > 0) && (
        <Card>
          <CardContent className="py-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-1.5">
              <Clock className="h-4 w-4" />
              3. Create Sheet Revision (Immutable)
            </h3>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Sheet</Label>
                <Select value={selectedSheetId ?? ''} onValueChange={setSelectedSheetId}>
                  <SelectTrigger className="w-64 h-8"><SelectValue placeholder="Select sheet…" /></SelectTrigger>
                  <SelectContent>
                    {artifacts.flatMap((a) => (a.sheets || []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>{a.fileName} / {s.sheetNumber}</SelectItem>
                    )))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Revision</Label>
                <Input value={revisionName} onChange={(e) => setRevisionName(e.target.value)}
                  placeholder="Rev C" className="w-32 h-8" />
              </div>
              <Button onClick={handleCreateRevision} disabled={creatingRevision} size="sm" className="h-8">
                {creatingRevision ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Create Revision'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 4: Create Measurement */}
      {artifacts.some((a) => (a.sheets || []).some((s) => (s.revisions || []).length > 0)) && (
        <Card>
          <CardContent className="py-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-1.5">
              <Ruler className="h-4 w-4" />
              4. Create Manual Measurement (Immutable Evidence)
            </h3>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Revision</Label>
                <Select value={selectedRevisionId ?? ''} onValueChange={setSelectedRevisionId}>
                  <SelectTrigger className="w-64 h-8"><SelectValue placeholder="Select revision…" /></SelectTrigger>
                  <SelectContent>
                    {artifacts.flatMap((a) => (a.sheets || []).flatMap((s) => (s.revisions || []).map((r) => (
                      <SelectItem key={r.id} value={r.id}>{a.fileName} / {s.sheetNumber} / {r.revision}</SelectItem>
                    ))))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Element Ref (optional)</Label>
                <Input value={elementRef} onChange={(e) => setElementRef(e.target.value)}
                  placeholder="wall-grid-B7" className="w-36 h-8" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Method</Label>
                <Select value={method} onValueChange={(v) => setMethod(v as MeasurementMethod)}>
                  <SelectTrigger className="w-36 h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MEASUREMENT_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Quantity</Label>
                <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)}
                  placeholder="184.6" className="w-24 h-8" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Unit</Label>
                <Input value={unit} onChange={(e) => setUnit(e.target.value)}
                  className="w-16 h-8" />
              </div>
              <div className="space-y-1 grow">
                <Label className="text-xs text-muted-foreground">Basis (JSON provenance)</Label>
                <Input value={basisJson} onChange={(e) => setBasisJson(e.target.value)}
                  placeholder='{"scale":"1:100"}' className="w-56 h-8" />
              </div>
              <Button onClick={handleCreateMeasurement} disabled={creatingMeasurement} size="sm" className="h-8">
                {creatingMeasurement ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Create'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 5: Link to EstimateLine */}
      {allMeasurements.length > 0 && (
        <Card>
          <CardContent className="py-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-1.5">
              <Link2 className="h-4 w-4" />
              5. Link Measurement to EstimateLine
            </h3>
            <p className="text-xs text-muted-foreground">
              This sets the mutable current lineage pointer. One measurement can support multiple lines.
              Rebinding doesn't affect the old measurement (immutable evidence).
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Measurement</Label>
                <Select value={selectedMeasurementId ?? ''} onValueChange={setSelectedMeasurementId}>
                  <SelectTrigger className="w-72 h-8"><SelectValue placeholder="Select measurement…" /></SelectTrigger>
                  <SelectContent>
                    {allMeasurements.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label} ({m.quantity} {m.unit})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">EstimateLine</Label>
                <Select value={selectedLineId ?? ''} onValueChange={setSelectedLineId}>
                  <SelectTrigger className="w-64 h-8"><SelectValue placeholder="Select line…" /></SelectTrigger>
                  <SelectContent>
                    {estimateLines.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.description} ({l.quantity} {l.unit})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleLink} disabled={linking} size="sm" className="h-8">
                {linking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Link'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Measurement List with Provenance */}
      {allMeasurements.length > 0 && (
        <Card>
          <CardContent className="py-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4" />
              Measurements & Lineage
            </h3>
            <div className="space-y-2">
              {artifacts.flatMap((a) => (a.sheets || []).flatMap((s) => (s.revisions || []).flatMap((r) => (r.measurements || []).map((m) => (
                <div key={m.id} className="rounded-md border border-border/60 bg-background/40 p-3 text-xs space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{m.quantity} {m.unit}</span>
                    <span className="text-muted-foreground">{m.measurementMethod}</span>
                    {m.elementReference && <span className="text-muted-foreground">— {m.elementReference}</span>}
                  </div>
                  <div className="text-muted-foreground">
                    {a.fileName} / {s.sheetNumber} / {r.revision}
                  </div>
                  <div className="text-muted-foreground/60">
                    Hash: {m.contentHash.substring(0, 24)}…
                  </div>
                  {m.estimateLines && m.estimateLines.length > 0 && (
                    <div className="text-emerald-600 dark:text-emerald-400">
                      Linked to: {m.estimateLines.map((l) => l.description).join(', ')}
                    </div>
                  )}
                </div>
              )))))}
            </div>
          </CardContent>
        </Card>
      )}

      {artifacts.length === 0 && (
        <Card>
          <CardContent className="py-3 flex items-start gap-3">
            <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground">
              No drawing artifacts registered yet. Upload a drawing file above to begin the
              measurement → EstimateLine evidence chain.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
