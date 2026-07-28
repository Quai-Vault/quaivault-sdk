import type { DecodedRevert } from '../types.js';

/** Machine-readable error codes. Stable across releases. */
export type QuaiVaultErrorCode =
  | 'ABORTED'
  | 'CONFIG'
  | 'NOT_CONNECTED'
  | 'NO_SIGNER'
  | 'NO_INDEXER'
  | 'INDEXER_QUERY'
  | 'INDEXER_STALE'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'PRECONDITION'
  | 'REVERT'
  | 'SALT_MINING'
  | 'STALE_PROPOSAL'
  | 'UNSUPPORTED';

export class QuaiVaultError extends Error {
  readonly code: QuaiVaultErrorCode;
  /** What the caller can do about it, in plain language. */
  readonly remediation?: string;
  /** Unix seconds after which retrying could succeed. */
  readonly retryableAt?: number;
  override readonly cause?: unknown;

  constructor(
    code: QuaiVaultErrorCode,
    message: string,
    options: { remediation?: string; retryableAt?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.remediation = options.remediation;
    this.retryableAt = options.retryableAt;
    this.cause = options.cause;
  }

  /** Structured form, for logs and machine consumers. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      retryableAt: this.retryableAt,
    };
  }
}

/**
 * A caller-supplied `AbortSignal` fired.
 *
 * Every long-running operation the SDK exposes — retries, indexer polling, salt
 * mining, waiting for a timelock — accepts a signal, and each used to report abort
 * differently: a bare `Error('Aborted')` in two places, a `PreconditionError` in a
 * third. Consumers switching on `err.code` to distinguish "the user pressed Ctrl-C"
 * from "this genuinely failed" could not do so. They can now.
 */
export class AbortError extends QuaiVaultError {
  constructor(operation = 'The operation') {
    super('ABORTED', `${operation} was aborted.`);
  }
}

export class ConfigError extends QuaiVaultError {
  constructor(message: string, remediation?: string) {
    super('CONFIG', message, { remediation });
  }
}

export class NoSignerError extends QuaiVaultError {
  constructor(operation: string) {
    super('NO_SIGNER', `${operation} requires a signer.`, {
      remediation:
        'Pass connect({ privateKey }) or connect({ signer }), or set QUAIVAULT_PRIVATE_KEY.',
    });
  }
}

export class NoIndexerError extends QuaiVaultError {
  constructor(operation: string) {
    super('NO_INDEXER', `${operation} requires the indexer, which is not configured.`, {
      remediation:
        'Set QUAIVAULT_INDEXER_URL, QUAIVAULT_INDEXER_ANON_KEY and QUAIVAULT_INDEXER_SCHEMA.',
    });
  }
}

export class IndexerQueryError extends QuaiVaultError {
  constructor(message: string, cause?: unknown) {
    super('INDEXER_QUERY', message, { cause });
  }
}

export class ValidationError extends QuaiVaultError {
  constructor(message: string, remediation?: string) {
    super('VALIDATION', message, { remediation });
  }
}

export class NotFoundError extends QuaiVaultError {
  constructor(message: string) {
    super('NOT_FOUND', message);
  }
}

/** A precondition the contract enforces would fail — checked before signing. */
export class PreconditionError extends QuaiVaultError {
  constructor(message: string, options: { remediation?: string; retryableAt?: number } = {}) {
    super('PRECONDITION', message, options);
  }
}

/** A contract call reverted. Carries the decoded custom error when resolvable. */
export class RevertError extends QuaiVaultError {
  readonly revert?: DecodedRevert;

  constructor(message: string, revert?: DecodedRevert, options: { remediation?: string; cause?: unknown } = {}) {
    super('REVERT', message, options);
    this.revert = revert;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), revert: this.revert };
  }
}

export class SaltMiningError extends QuaiVaultError {
  constructor(message: string, remediation?: string) {
    super('SALT_MINING', message, { remediation });
  }
}

/**
 * A `disableModule` proposal whose baked-in `prevModule` no longer matches the
 * live linked list. The proposal can never execute and must be replaced.
 */
export class StaleProposalError extends QuaiVaultError {
  constructor(message: string) {
    super('STALE_PROPOSAL', message, {
      remediation: 'Cancel this proposal and create a new one against the current module list.',
    });
  }
}
