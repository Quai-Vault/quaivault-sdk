/**
 * Display sanitisation for attacker-controlled strings.
 *
 * Two values reach a consumer's screen without ever having been vetted by anyone:
 *
 * - **Token metadata.** `symbol()` and `name()` are whatever the token's deployer
 *   chose. Getting one indexed against a vault costs one transfer of one unit.
 * - **Revert reasons.** `Error(string)` data comes from the contract a vault called,
 *   which for an external call is an arbitrary address the proposer picked.
 *
 * In a browser both are inert — the DOM escapes them. In a terminal they are not. An
 * ANSI escape can move the cursor up and overwrite lines the SDK already printed, so
 * a token named `"\x1b[2A\x1b[KAll checks passed"` can forge SDK output. Bidi
 * overrides can reverse a rendered address while leaving the underlying bytes intact,
 * which is the same trick that makes malicious source look benign.
 *
 * Sanitising here rather than in each consumer means a CLI, a TUI and a log pipeline
 * all inherit it, and none of them has to remember. Only human-facing fields are
 * scrubbed — machine-readable ones (`DecodedRevert.args`) keep the raw bytes, because
 * a consumer comparing against an expected value needs exactly what was on chain.
 */

/**
 * Characters removed outright: C0 and C1 controls (including ESC, which starts every
 * ANSI sequence), DEL, the bidirectional embedding and override marks, the invisible
 * word joiners, and the zero-width space family used for homoglyph padding.
 */
const UNSAFE_CHARS = new RegExp(
  [
    '[\\u0000-\\u001F', // C0 controls, incl. ESC (0x1B) — the head of every ANSI sequence
    '\\u007F-\\u009F', // DEL and the C1 controls
    '\\u200B-\\u200F', // zero-width space/joiners, LRM, RLM
    '\\u202A-\\u202E', // bidi embeddings and overrides
    '\\u2060-\\u2064', // word joiner and the invisible operators
    '\\u2066-\\u2069', // bidi isolates
    '\\uFEFF]', // zero-width no-break space / BOM
  ].join(''),
  'g',
);

/** Default cap. Long enough for any legitimate token name, short enough to not wrap. */
export const DEFAULT_TEXT_LIMIT = 128;

/**
 * Strip control and direction-manipulating characters, collapse surrounding
 * whitespace, and cap the length.
 *
 * Returns `''` for a non-string or for input that was entirely unsafe, so callers can
 * `sanitizeText(x) || fallback`.
 */
export function sanitizeText(value: unknown, maxLength: number = DEFAULT_TEXT_LIMIT): string {
  if (typeof value !== 'string') return '';

  const cleaned = value.replace(UNSAFE_CHARS, '').trim();
  if (cleaned.length <= maxLength) return cleaned;

  // Truncate to the cap *including* the ellipsis, so the result never exceeds what
  // the caller budgeted for.
  return `${cleaned.slice(0, Math.max(0, maxLength - 1))}…`;
}
