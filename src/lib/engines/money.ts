/**
 * Money utilities for the Contractor OS.
 *
 * All monetary values are GHS (Ghana Cedi), represented as `number` and
 * rounded to 2 decimal places using banker's rounding (round half to even)
 * to avoid the systematic upward bias of plain "round half up".
 *
 * These helpers are pure: no `Math.random`, no `Date.now`, no I/O.
 * They are the canonical financial-arithmetic layer of the product
 * (INVARIANT 6: Financial logic is deterministic and testable).
 */

/**
 * Round a number to 2 decimal places using banker's rounding
 * (a.k.a. "round half to even").
 *
 * Non-finite values (NaN, +/-Infinity) are returned as 0.
 *
 * Implementation notes:
 * - Floating-point representation noise (e.g. `1.015` is actually stored as
 *   `1.0149999999999998`) is absorbed by scaling by 1e8 and using `Math.round`
 *   before applying the half-to-even rule. This correctly yields `1.02` for
 *   `1.015` and `0.14` for `0.145`, which naive `n.toFixed(2)` gets wrong.
 * - Safe for monetary values up to ~10 million GHS. Above that, IEEE-754
 *   double precision may degrade; callers doing treasury-scale maths should
 *   use a decimal library.
 *
 * @param n - The number to round.
 * @returns The banker's-rounded value at 2 decimal places.
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  // Scale to integer space with 2 extra digits of precision to absorb
  // floating-point representation noise, then bring back to "n * 100".
  const scaled = Math.round(abs * 1e8) / 1e6;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  let rounded: number;
  if (frac < 0.5) {
    rounded = floor;
  } else if (frac > 0.5) {
    rounded = floor + 1;
  } else {
    // Exactly halfway — round to even (banker's rounding).
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  return (sign * rounded) / 100;
}

/**
 * Sum a list of numbers. Non-finite values (NaN, Infinity) are skipped.
 *
 * The result is NOT rounded — callers should `round2` the result if a
 * 2-decimal monetary value is required.
 *
 * @param nums - The numbers to sum.
 * @returns The arithmetic sum of all finite inputs.
 */
export function sum(nums: number[]): number {
  let total = 0;
  for (const n of nums) {
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

/**
 * Format a number as a GHS currency string with thousands separators and
 * exactly 2 decimal places. Example: `12345.678` → `"GHS 12,345.68"`.
 *
 * The value is first canonicalised via `round2` so the formatted output is
 * always consistent with the canonical monetary representation.
 *
 * @param n - The number to format.
 * @returns A formatted GHS string (always 2 decimals, thousands-separated).
 */
export function formatGHS(n: number): string {
  const rounded = round2(n);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  // Split into integer and decimal parts manually for deterministic output
  // (independent of runtime locale settings).
  const fixed = abs.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withSeparators = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}GHS ${withSeparators}.${decPart}`;
}
