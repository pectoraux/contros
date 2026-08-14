/**
 * Scope Completeness Engine — deterministic 0..1 score for a ScopePackage.
 *
 * Pure: no `Math.random`, no `Date.now`, no I/O. Callers pass plain data
 * (typically projected from `ScopeItem` and `ScopeQuestion` rows).
 */

/** Result of `computeScopeCompleteness`. */
export interface ScopeCompletenessResult {
  /** 0..1 score, rounded to 2 decimals. 0 if there are no items. */
  score: number;
  knownCount: number;
  missingCount: number;
  ambiguousCount: number;
  /** Descriptions of items with status "known". */
  known: string[];
  /** Descriptions of items with status "missing". */
  missing: string[];
  /** Descriptions of items with status "ambiguous". */
  ambiguous: string[];
  /** Count of open scope questions. */
  openQuestions: number;
}

/** Input item — a flattened `ScopeItem`. */
export interface ScopeCompletenessItem {
  description: string;
  status: 'known' | 'missing' | 'ambiguous';
  category?: string;
}

/** Input question — a flattened `ScopeQuestion`. */
export interface ScopeCompletenessQuestion {
  status: string;
}

/**
 * Compute a deterministic scope-completeness score for a scope package.
 *
 * Algorithm:
 * - Partition items by `status` into known / missing / ambiguous buckets.
 * - `score = known / (known + missing + ambiguous)`, rounded to 2 decimals.
 *   If there are no items, `score = 0`.
 * - `openQuestions` = count of questions whose `status` is `"open"`.
 *
 * @param items - The scope items.
 * @param questions - The scope questions.
 * @returns A `ScopeCompletenessResult`.
 */
export function computeScopeCompleteness(
  items: ScopeCompletenessItem[],
  questions: ScopeCompletenessQuestion[],
): ScopeCompletenessResult {
  const known: string[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];

  for (const item of items) {
    if (!item) continue;
    const desc = item.description ?? '';
    if (item.status === 'known') known.push(desc);
    else if (item.status === 'missing') missing.push(desc);
    else if (item.status === 'ambiguous') ambiguous.push(desc);
    // Unknown status values are ignored (defensive).
  }

  const total = known.length + missing.length + ambiguous.length;
  const score = total > 0 ? Math.round((known.length / total) * 100) / 100 : 0;

  let openQuestions = 0;
  for (const q of questions) {
    if (q && q.status === 'open') openQuestions += 1;
  }

  return {
    score,
    knownCount: known.length,
    missingCount: missing.length,
    ambiguousCount: ambiguous.length,
    known,
    missing,
    ambiguous,
    openQuestions,
  };
}
