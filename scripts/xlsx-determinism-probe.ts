// ─────────────────────────────────────────────────────────────────────────────
// XLSX Serializer Determinism Probe (EVALUATION HARNESS — not a product test)
//
// Purpose: empirically determine whether candidate XLSX serializers produce
// byte-for-byte identical output when serializing the SAME XlsxArtifact twice.
//
// This is NOT a product invariant. The canonical adapter invariant
// (same inputs → same XlsxArtifact) is guaranteed. The strong byte invariant
// (same inputs → byte-identical XLSX) is CANDIDATE-DEPENDENT and must be
// EXPERIMENTALLY PROVEN per pinned serializer version.
//
// Method:
//   1. Build ONE fixed XlsxArtifact (from a real BoqProjection).
//   2. For each candidate serializer:
//      a. Serialize the artifact to a Buffer twice (back-to-back).
//      b. Compare the two Buffers byte-for-byte.
//      c. SHA-256 each Buffer; capture byte length.
//      d. If unequal: unzip both, list ZIP entry names/order, diff the XML
//         entries, and flag timestamp-bearing metadata.
//   3. Print a structured report.
//
// Run: bun run scripts/xlsx-determinism-probe.ts
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { unzipSync, inflateSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import {
  finalizeRevision,
  type LineSnapshot,
  type PolicySnapshot,
} from '../src/lib/engines/revision-service'
import { projectRevision } from '../src/lib/boq/projection'
import {
  buildXlsxArtifact,
  CURRENT_XLSX_ADAPTER_VERSION,
  DEFAULT_XLSX_FORMATTING,
} from '../src/lib/boq/xlsx-adapter'
import type { XlsxArtifact } from '../src/lib/boq/xlsx-adapter-contract'

// ─── Fixed artifact fixture ─────────────────────────────────────────────────

function makeLine(overrides: Partial<LineSnapshot> = {}): LineSnapshot {
  return {
    lineId: 'line-1',
    description: 'PVC conduit 25mm',
    quantity: 100,
    unit: 'm',
    executionStrategy: 'self-perform',
    workDefinitionVersion: {
      id: 'wdv-1',
      name: 'PVC Conduit',
      version: 1,
      unit: 'm',
      wastage: 0.05,
      costRecipeJson: JSON.stringify([
        { resource: 'PVC pipe', component: 'material', unitCost: 5, unitQuantity: 1.05 },
      ]),
    },
    executionSegments: [],
    ...overrides,
  }
}

const POLICY: PolicySnapshot = { overheadPct: 0.1, profitPct: 0.1, contingencyPct: 0.02 }

function buildFixedArtifact(): XlsxArtifact {
  const snap = finalizeRevision('est-1', 1, POLICY, [
    makeLine({ lineId: 'l1' }),
    makeLine({ lineId: 'l2', quantity: 50, description: 'Concrete work' }),
  ])
  const projection = projectRevision({
    estimateRevisionId: 'rev-1',
    snapshotJson: snap,
    projectionVersion: 1 as never,
  })
  return buildXlsxArtifact({
    projection,
    adapterVersion: CURRENT_XLSX_ADAPTER_VERSION,
    formatting: DEFAULT_XLSX_FORMATTING,
  })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Unzip a Buffer and return a map of entry name → content (string). */
function unzipEntries(buf: Buffer): Map<string, string> {
  const entries = new Map<string, string>()
  const unzipped = unzipSync(buf)
  // unzipSync returns a single Buffer for the whole archive if there's one
  // entry, or concatenated. We need per-entry, so use the async API instead.
  void unzipped
  return entries
}

// node:zlib unzipSync doesn't handle multi-entry ZIPs cleanly. Use a manual
// ZIP central-directory parse, or — simpler — use the `unzip` from node:zlib
// via a different approach. The cleanest portable way without adding a dep is
// to use Node's built-in `zlib.unzip` (which handles gzip/deflate) but ZIP is
// a container, not a single deflate stream. We'll do a minimal ZIP parse.

/** Minimal ZIP entry extraction (central directory). Returns Map<name, content>. */
function parseZipEntries(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  // Find the End of Central Directory record (EOCD): 0x06054b50
  let eocdOffset = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset === -1) return entries
  const cdCount = buf.readUInt16LE(eocdOffset + 10)
  let cdOffset = buf.readUInt32LE(eocdOffset + 16)
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) break
    const compMethod = buf.readUInt16LE(cdOffset + 10)
    const compSize = buf.readUInt32LE(cdOffset + 20)
    const uncompSize = buf.readUInt32LE(cdOffset + 24)
    const nameLen = buf.readUInt16LE(cdOffset + 28)
    const extraLen = buf.readUInt16LE(cdOffset + 30)
    const commentLen = buf.readUInt16LE(cdOffset + 32)
    const localHeaderOffset = buf.readUInt32LE(cdOffset + 42)
    const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen)
    // Read the local header to find the actual data offset.
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26)
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28)
    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen
    const compData = buf.subarray(dataOffset, dataOffset + compSize)
    let content: Buffer
    if (compMethod === 0) {
      content = compData // stored, no compression
    } else if (compMethod === 8) {
      // deflate — use zlib.inflate (raw deflate; may need raw-inflate for some entries)
      content = inflateSync(compData)
    } else {
      content = Buffer.from(`[unsupported compression method ${compMethod}]`)
    }
    void uncompSize
    entries.set(name, content)
    cdOffset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Flag timestamp/metadata-bearing XML content for audit. */
function flagTimestampMetadata(entries: Map<string, Buffer>): string[] {
  const flags: string[] = []
  for (const [name, content] of entries) {
    const text = content.toString('utf8')
    // Look for common XLSX metadata sources: docProps/core.xml (created/modified),
    // docProps/app.xml, and any <created>/<modified> tags.
    if (name === 'docProps/core.xml' || name === 'docProps/app.xml') {
      flags.push(`${name} (metadata file present)`)
    }
    if (/<(?:created|modified)[ >]/i.test(text)) {
      const m = text.match(/<(?:created|modified)[^>]*>([^<]+)</i)
      if (m) flags.push(`${name}: ${m[0]}`)
    }
  }
  return flags
}

/** Diff two sets of ZIP entries: names, order, and content. */
function diffZipEntries(a: Map<string, Buffer>, b: Map<string, Buffer>): {
  entryNamesA: string[]
  entryNamesB: string[]
  sameOrder: boolean
  differingEntries: string[]
} {
  const namesA = [...a.keys()]
  const namesB = [...b.keys()]
  const sameOrder = JSON.stringify(namesA) === JSON.stringify(namesB)
  const allNames = new Set([...namesA, ...namesB])
  const differing: string[] = []
  for (const name of allNames) {
    const ca = a.get(name)
    const cb = b.get(name)
    if (!ca || !cb) {
      differing.push(`${name} (missing in ${!ca ? 'A' : 'B'})`)
    } else if (!ca.equals(cb)) {
      differing.push(name)
    }
  }
  return { entryNamesA: namesA, entryNamesB: namesB, sameOrder, differingEntries: differing }
}

// ─── Candidate serializers ──────────────────────────────────────────────────

interface SerializeResult {
  buffer: Buffer
  sha256: string
  byteLength: number
}

/** Serialize via write-excel-file. */
async function serializeWithWriteExcelFile(artifact: XlsxArtifact): Promise<SerializeResult> {
  // write-excel-file cell `type` uses CONSTRUCTORS (String, Number), not
  // string literals. For empty cells, omit type and set value: null.
  const writeXlsxFile = (await import('write-excel-file/node')).default
  const sheet = artifact.worksheets[0]
  const data = sheet.rows.map((row) =>
    row.cells.map((cell) => {
      if (cell.value === null) return { value: null }
      if (typeof cell.value === 'number') return { value: cell.value, type: Number }
      return { value: cell.value, type: String }
    }),
  )
  const result = await writeXlsxFile([{ data, name: sheet.name }])
  const buffer = await result.toBuffer()
  return { buffer, sha256: sha256(buffer), byteLength: buffer.length }
}

/** Serialize via ExcelJS. Uses write-to-file to avoid a Bun writeBuffer quirk. */
async function serializeWithExcelJS(artifact: XlsxArtifact): Promise<SerializeResult> {
  const ExcelJS = await import('exceljs')
  const { unlinkSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const wb = new ExcelJS.Workbook()
  const sheet = artifact.worksheets[0]
  const ws = wb.addWorksheet(sheet.name)
  ws.columns = sheet.columns.map((col) => ({
    key: col.field,
    width: col.width,
    numFmt: col.numberFormat ?? undefined,
  }))
  for (const row of sheet.rows) {
    const values: Record<string, string | number | null> = {}
    row.cells.forEach((cell, i) => {
      values[sheet.columns[i].field] = cell.value
    })
    ws.addRow(values)
  }
  // Write to a temp file, read the bytes back, delete the file.
  const tmpFile = join(tmpdir(), `exceljs-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`)
  await wb.xlsx.writeFile(tmpFile)
  const { readFileSync } = await import('node:fs')
  const buf = readFileSync(tmpFile)
  try { unlinkSync(tmpFile) } catch { /* best effort */ }
  return { buffer: buf, sha256: sha256(buf), byteLength: buf.length }
}

// ─── Probe runner ───────────────────────────────────────────────────────────

interface CandidateResult {
  library: string
  version: string
  serialize1: SerializeResult
  serialize2: SerializeResult
  byteIdentical: boolean
  zipEntries1: Map<string, Buffer>
  zipEntries2: Map<string, Buffer>
  zipDiff: ReturnType<typeof diffZipEntries>
  timestampMetadata1: string[]
}

async function probeCandidate(
  library: string,
  version: string,
  serialize: (artifact: XlsxArtifact) => Promise<SerializeResult>,
  artifact: XlsxArtifact,
): Promise<CandidateResult> {
  const serialize1 = await serialize(artifact)
  const serialize2 = await serialize(artifact)
  const byteIdentical = serialize1.buffer.equals(serialize2.buffer)
  // ZIP parsing may fail if the serializer uses an unusual compression; wrap
  // so the byte-comparison result is still reported.
  let zipEntries1 = new Map<string, Buffer>()
  let zipEntries2 = new Map<string, Buffer>()
  let zipParseError: string | null = null
  try {
    zipEntries1 = parseZipEntries(serialize1.buffer)
    zipEntries2 = parseZipEntries(serialize2.buffer)
  } catch (e) {
    zipParseError = e instanceof Error ? e.message : String(e)
  }
  const zipDiff = diffZipEntries(zipEntries1, zipEntries2)
  const timestampMetadata1 = flagTimestampMetadata(zipEntries1)
  const result: CandidateResult = { library, version, serialize1, serialize2, byteIdentical, zipEntries1, zipEntries2, zipDiff, timestampMetadata1 }
  if (zipParseError) (result as CandidateResult & { zipParseError?: string }).zipParseError = zipParseError
  return result
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== XLSX Serializer Determinism Probe ===')
  console.log(`Runtime: node ${process.version}, bun ${Bun.version}`)
  console.log(`Timestamp: ${new Date().toISOString()}\n`)

  const artifact = buildFixedArtifact()
  console.log(`Fixed XlsxArtifact: ${artifact.worksheets[0].rows.length} rows, sourceContentHash=${artifact.sourceContentHash}\n`)

  const results: CandidateResult[] = []

  // Candidate 1: write-excel-file
  try {
    const wefVersion = require('write-excel-file/package.json').version
    console.log(`Probing write-excel-file@${wefVersion}...`)
    results.push(await probeCandidate('write-excel-file', wefVersion, serializeWithWriteExcelFile, artifact))
  } catch (e) {
    console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Candidate 2: ExcelJS (comparison baseline)
  try {
    const ejVersion = require('exceljs/package.json').version
    console.log(`Probing exceljs@${ejVersion}...`)
    results.push(await probeCandidate('exceljs', ejVersion, serializeWithExcelJS, artifact))
  } catch (e) {
    console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Report
  console.log('\n=== REPORT ===\n')
  for (const r of results) {
    console.log(`Library: ${r.library}@${r.version}`)
    console.log(`  Serialize 1: ${r.serialize1.byteLength} bytes, sha256=${r.serialize1.sha256.substring(0, 16)}…`)
    console.log(`  Serialize 2: ${r.serialize2.byteLength} bytes, sha256=${r.serialize2.sha256.substring(0, 16)}…`)
    console.log(`  Byte-identical: ${r.byteIdentical ? 'YES ✅' : 'NO ❌'}`)
    const zipErr = (r as CandidateResult & { zipParseError?: string }).zipParseError
    if (zipErr) {
      console.log(`  ZIP parse error: ${zipErr}`)
      console.log(`  (byte comparison still valid above; ZIP-level diff unavailable)`)
    }
    console.log(`  ZIP entries (run 1): ${[...r.zipEntries1.keys()].length} entries`)
    console.log(`  ZIP entry order identical: ${r.zipDiff.sameOrder ? 'YES' : 'NO'}`)
    if (!r.byteIdentical) {
      console.log(`  Differing entries: ${r.zipDiff.differingEntries.length === 0 ? '(none at XML level — diff is in binary/metadata)' : r.zipDiff.differingEntries.join(', ')}`)
      if (r.zipDiff.differingEntries.length > 0) {
        for (const name of r.zipDiff.differingEntries.slice(0, 3)) {
          const c1 = r.zipEntries1.get(name)?.toString('utf8').substring(0, 200) ?? '(missing)'
          const c2 = r.zipEntries2.get(name)?.toString('utf8').substring(0, 200) ?? '(missing)'
          console.log(`    — ${name}:`)
          console.log(`      run1: ${c1.substring(0, 150)}…`)
          console.log(`      run2: ${c2.substring(0, 150)}…`)
        }
      }
    }
    console.log(`  Timestamp/metadata flags: ${r.timestampMetadata1.length === 0 ? '(none)' : r.timestampMetadata1.join('; ')}`)
    console.log('')
  }

  console.log('=== STATUS ===')
  console.log('Canonical invariant (same inputs → same XlsxArtifact): GUARANTEED ✅')
  console.log('Strong byte invariant (same inputs → byte-identical XLSX): CANDIDATE-DEPENDENT 🔶')
  for (const r of results) {
    console.log(`  ${r.library}@${r.version}: ${r.byteIdentical ? 'byte-identical ✅ (can be promoted to a tested invariant for this pinned version)' : 'NOT byte-identical ❌ (canonical invariant still holds; strong invariant does NOT hold for this library)'}`)
  }
}

main().catch((e) => {
  console.error('Probe failed:', e)
  process.exit(1)
})
