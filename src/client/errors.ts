export class GeneanetApiError extends Error {
  // `string`, not the literal, so a subclass can override it.
  override readonly name: string = "GeneanetApiError";
  readonly status: number;
  /**
   * What to do about it, kept separate from `message`: the message says what
   * happened, the remedy is the half a model should act on, and fail() lifts it
   * to a top-level field so it is not buried inside the upstream envelope.
   */
  readonly remedy: string | undefined;
  readonly errors: unknown;

  constructor(message: string, opts: { status: number; remedy?: string; errors?: unknown }) {
    super(message);
    this.status = opts.status;
    this.remedy = opts.remedy;
    this.errors = opts.errors;
  }
}

/**
 * Cloudflare answered instead of Geneanet. The tree API and the POSTed search
 * get through today because Cloudflare only challenges GETs on this site; the
 * day that changes, every call lands here, so the message says so plainly
 * instead of looking like a parse failure.
 */
export class BlockedError extends GeneanetApiError {
  override readonly name: string = "BlockedError";
}
