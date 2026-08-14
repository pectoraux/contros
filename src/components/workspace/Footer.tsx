'use client'

import { HardHat } from 'lucide-react'

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border bg-background px-6 py-3">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-2">
          <HardHat className="h-3.5 w-3.5" />
          <span>Contractor OS — Construction Industry Pack (Ghana)</span>
        </div>
        <div className="flex items-center gap-4">
          <span>Domain model is canonical · Estimate ≠ BOQ · AI advisory only</span>
          <span className="hidden sm:inline">·</span>
          <span className="hidden sm:inline">SQLite working replica · GHS</span>
        </div>
      </div>
    </footer>
  )
}
