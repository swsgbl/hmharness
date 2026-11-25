/**
 * @hmharness/kernel - deadline
 *
 * A deadline signal for a configured timeout value — the declarative form of
 * `const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), ms)`,
 * with no timer to clear in a `finally`.
 *
 * Values a hand-edited config.json can hold are coerced the way `setTimeout`
 * used to coerce them (NaN, negative and non-numeric values become an
 * immediate deadline; values beyond the platform range are clamped): left
 * raw they make `AbortSignal.timeout()` throw instead.
 */

const MAX_TIMEOUT_MS = 0xFFFF_FFFF; // WebIDL unsigned long: the largest delay AbortSignal.timeout accepts

export function deadlineSignal(ms: number): AbortSignal {
  const n = Number(ms);
  return AbortSignal.timeout(Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_TIMEOUT_MS) : 0);
}
