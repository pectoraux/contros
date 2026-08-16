'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { apiGet, apiPost } from '@/lib/api'
import { useWorkspace } from '@/store/workspace'
import { toast } from 'sonner'
import { Plus, Building2, User as UserIcon } from 'lucide-react'
import { format } from 'date-fns'

interface Client {
  id: string
  name: string
  sector: string | null
}

interface NewOpportunityDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NewOpportunityDialog({ open, onOpenChange }: NewOpportunityDialogProps) {
  const [clients, setClients] = useState<Client[]>([])
  const [loadingClients, setLoadingClients] = useState(false)
  const [creating, setCreating] = useState(false)
  const [showNewClient, setShowNewClient] = useState(false)
  const [newClientName, setNewClientName] = useState('')
  const [newClientSector, setNewClientSector] = useState<string>('')

  // Form state
  const [clientId, setClientId] = useState('')
  const [title, setTitle] = useState('')
  const [reference, setReference] = useState('')
  const [source, setSource] = useState('')
  const [description, setDescription] = useState('')
  const [submissionDeadline, setSubmissionDeadline] = useState('')
  const [location, setLocation] = useState('')

  const openOpportunity = useWorkspace((s) => s.openOpportunity)
  const setView = useWorkspace((s) => s.setView)

  const loadClients = useCallback(async () => {
    setLoadingClients(true)
    try {
      const data = await apiGet<{ clients: Client[] }>('/api/clients')
      setClients(data.clients)
    } catch {
      // Silent fail — client list is optional
    } finally {
      setLoadingClients(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      loadClients()
      // Reset form
      setClientId('')
      setTitle('')
      setReference('')
      setSource('')
      setDescription('')
      setSubmissionDeadline('')
      setLocation('')
      setShowNewClient(false)
      setNewClientName('')
      setNewClientSector('')
    }
  }, [open, loadClients])

  const handleCreateClient = async () => {
    if (!newClientName.trim()) {
      toast.error('Client name is required')
      return
    }
    try {
      const result = await apiPost<{ clientId: string }>('/api/clients', {
        name: newClientName.trim(),
        sector: newClientSector || null,
      })
      toast.success('Client created')
      // Add to local list and select
      const newClient: Client = {
        id: result.clientId,
        name: newClientName.trim(),
        sector: newClientSector || null,
      }
      setClients((prev) => [...prev, newClient])
      setClientId(result.clientId)
      setShowNewClient(false)
      setNewClientName('')
      setNewClientSector('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create client')
    }
  }

  const handleSubmit = async () => {
    if (!clientId) {
      toast.error('Please select a client')
      return
    }
    if (!title.trim()) {
      toast.error('Opportunity title is required')
      return
    }

    setCreating(true)
    try {
      const result = await apiPost<{ opportunityId: string }>('/api/opportunities', {
        clientId,
        title: title.trim(),
        reference: reference.trim() || null,
        source: source || null,
        description: description.trim() || null,
        submissionDeadline: submissionDeadline || null,
        location: location.trim() || null,
      })

      toast.success('Opportunity created')
      onOpenChange(false)

      // Navigate to the new opportunity workspace
      openOpportunity(result.opportunityId, 'overview')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create opportunity')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            New Opportunity
          </DialogTitle>
          <DialogDescription>
            Create a new opportunity from an RFQ. The opportunity starts in &ldquo;received&rdquo; status with an auto-created scope package.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Client selection */}
          <div className="space-y-2">
            <Label>Client *</Label>
            {!showNewClient ? (
              <div className="flex gap-2">
                <Select value={clientId} onValueChange={setClientId}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder={loadingClients ? 'Loading clients...' : 'Select a client'} />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                        {c.sector && <span className="text-muted-foreground ml-1">· {c.sector}</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowNewClient(true)}
                  className="shrink-0"
                >
                  <Building2 className="h-4 w-4 mr-1" />
                  New
                </Button>
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border p-3 bg-muted/30">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <UserIcon className="h-4 w-4" />
                  New Client
                </div>
                <Input
                  placeholder="Client name"
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                />
                <Select value={newClientSector} onValueChange={setNewClientSector}>
                  <SelectTrigger>
                    <SelectValue placeholder="Sector (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public</SelectItem>
                    <SelectItem value="private">Private</SelectItem>
                    <SelectItem value="ngo">NGO</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleCreateClient}>Create Client</Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowNewClient(false)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>

          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="opp-title">Title *</Label>
            <Input
              id="opp-title"
              placeholder="e.g. Two-Storey Classroom Block — AMA Basic School"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Reference + Source */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="opp-ref">Reference</Label>
              <Input
                id="opp-ref"
                placeholder="e.g. AMA/TEN/2025/014"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Source</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger>
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">Direct</SelectItem>
                  <SelectItem value="tender-portal">Tender Portal</SelectItem>
                  <SelectItem value="referral">Referral</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Deadline + Location */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="opp-deadline">Submission Deadline</Label>
              <Input
                id="opp-deadline"
                type="date"
                value={submissionDeadline}
                onChange={(e) => setSubmissionDeadline(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="opp-location">Location</Label>
              <Input
                id="opp-location"
                placeholder="e.g. Accra"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="opp-desc">Description</Label>
            <Textarea
              id="opp-desc"
              placeholder="Brief description of the works..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={creating || !clientId || !title.trim()}>
            {creating ? 'Creating...' : 'Create Opportunity'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
