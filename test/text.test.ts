import { describe, expect, it } from 'vitest';
import { AbiCoder } from 'quais';
import { DEFAULT_TEXT_LIMIT, sanitizeText } from '../src/text.js';
import { decodeRevert } from '../src/errors/decode.js';

const ESC = '\u001B';
const NUL = '\u0000';
const DEL = '\u007F';
const C1 = '\u009B'; // CSI — an 8-bit escape introducer
const RLO = '\u202E'; // right-to-left override
const LRI = '\u2066';
const PDI = '\u2069';
const ZWSP = '\u200B';
const ZWJ = '\u200D';
const WJ = '\u2060';
const BOM = '\uFEFF';

describe('sanitizeText', () => {
  it('strips ANSI escape sequences', () => {
    // The forgery this exists to stop: move the cursor up two lines, clear, overwrite.
    const forged = `${ESC}[2A${ESC}[KAll checks passed`;
    expect(sanitizeText(forged)).toBe('[2A[KAll checks passed');
    expect(sanitizeText(forged)).not.toContain(ESC);
  });

  it('strips C0 controls including CR, LF, tab and NUL', () => {
    expect(sanitizeText(`a${NUL}b\rc\nd\te`)).toBe('abcde');
  });

  it('strips DEL and the C1 control block', () => {
    expect(sanitizeText(`a${DEL}b${C1}c`)).toBe('abc');
  });

  it('strips bidi overrides and isolates', () => {
    // RLO makes a rendered string read backwards while its bytes are unchanged.
    expect(sanitizeText(`USD${RLO}gnitset`)).toBe('USDgnitset');
    expect(sanitizeText(`a${LRI}b${PDI}c`)).toBe('abc');
  });

  it('strips zero-width and invisible characters', () => {
    expect(sanitizeText(`U${ZWSP}S${ZWJ}D${WJ}C${BOM}`)).toBe('USDC');
  });

  it('leaves ordinary unicode alone', () => {
    expect(sanitizeText('  Ünï çøde — 日本語  ')).toBe('Ünï çøde — 日本語');
  });

  it('caps length inclusive of the ellipsis', () => {
    const out = sanitizeText('x'.repeat(500), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('defaults to DEFAULT_TEXT_LIMIT', () => {
    expect(sanitizeText('x'.repeat(500))).toHaveLength(DEFAULT_TEXT_LIMIT);
  });

  it('returns empty string for non-strings and for wholly unsafe input', () => {
    expect(sanitizeText(undefined)).toBe('');
    expect(sanitizeText(42)).toBe('');
    expect(sanitizeText(`${ESC}${ZWSP}${RLO}`)).toBe('');
  });

  it('is idempotent', () => {
    const once = sanitizeText(`${ESC}[31mred${RLO}`);
    expect(sanitizeText(once)).toBe(once);
  });
});

describe('revert decoding is display-safe', () => {
  /** Encode `Error(string)` revert data carrying an arbitrary reason. */
  function errorRevert(reason: string): string {
    return '0x08c379a0' + AbiCoder.defaultAbiCoder().encode(['string'], [reason]).slice(2);
  }

  it('scrubs escapes out of the human-facing message', () => {
    const decoded = decodeRevert(errorRevert(`${ESC}[2AForged success`));
    expect(decoded?.message).toBe('[2AForged success');
    expect(decoded?.message).not.toContain(ESC);
  });

  it('leaves args raw so machine consumers see what was on chain', () => {
    const raw = `${ESC}[2AForged success`;
    const decoded = decodeRevert(errorRevert(raw));
    expect(decoded?.args[0]).toBe(raw);
  });
});
