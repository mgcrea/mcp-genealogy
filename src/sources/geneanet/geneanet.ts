// Two upstreams, one client, one rate gate:
//
// 1. The family-tree API: POST gw.geneanet.org/setup/api/?arbre=<op>&sourcename=<tree>,
//    protobuf in and out (see proto/README.md for the framing). It is what the
//    tree pages call themselves.
// 2. The site-wide search: POST en.geneanet.org/fonds/individus/?<form fields>,
//    which answers server-rendered HTML. The site's own form sends a GET, and
//    Cloudflare challenges every GET from a non-browser client. The same URL
//    POSTed with an empty body is not challenged (measured 2026-11-20). That is
//    a gap in Geneanet's bot protection, not an interface, and it can close
//    without notice: BlockedError is what that looks like.
//
// Every request is a POST, and none of them changes anything, so a timeout or a
// 5xx is safe to retry. Retries are still few and short, because this is a site
// that forbids automated access and the polite failure is a fast one.

import type { Logger } from "#/log";
import { BlockedError, DeadlineError, GeneanetApiError } from "#/sources/geneanet/errors";
import { decodeApiError } from "#/sources/geneanet/proto/messages";
import {
  ProtoDecodeError,
  ProtoMessage,
  frameRequest,
  unframeResponse,
} from "#/sources/geneanet/proto/wire";

/** Under this much time before a deadline, a request is not sent (or retried) at all. */
export const MIN_ATTEMPT_MS = 1000;

export type RequestOptions = {
  /**
   * Absolute time (on the client's clock) by which the request must be over,
   * retries included. Each attempt's timeout shrinks to fit; a request or a
   * retry that cannot start at least MIN_ATTEMPT_MS before it is not made.
   * Without one, only `timeoutMs` per attempt applies.
   */
  deadline?: number;
};

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

/** Capped so a hostile Retry-After cannot outlive the client's own call timeout. */
export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), 15) * 1000 : undefined;
};

/** Serialise requests so that two are never closer than `minIntervalMs`, across all tools. */
export const createRateGate = (
  minIntervalMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): (() => Promise<void>) => {
  let next = 0;
  let chain: Promise<void> = Promise.resolve();
  return () => {
    const turn = chain.then(async () => {
      const wait = next - now();
      if (wait > 0) await sleep(wait);
      next = now() + minIntervalMs;
    });
    chain = turn;
    return turn;
  };
};

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/26.0 Safari/605.1.15";

const isChallenge = (res: Response, text: string): boolean =>
  res.headers.get("cf-mitigated") === "challenge" ||
  (res.status === 403 && text.includes("<title>Just a moment...</title>"));

export type GeneanetClientOptions = {
  treeBaseUrl: string;
  siteBaseUrl: string;
  lang: string;
  minIntervalMs: number;
  maxRetries: number;
  timeoutMs: number;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Tests pass a no-op so the suite does not wait a second per call. */
  gate?: () => Promise<void>;
  /** The clock deadlines are read on. Defaults to Date.now. */
  now?: () => number;
};

export class GeneanetClient {
  private readonly opts: GeneanetClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly gate: () => Promise<void>;

  constructor(opts: GeneanetClientOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.gate = opts.gate ?? createRateGate(opts.minIntervalMs);
  }

  get treeBaseUrl(): string {
    return this.opts.treeBaseUrl;
  }

  get siteBaseUrl(): string {
    return this.opts.siteBaseUrl;
  }

  /** The client's clock: a `RequestOptions.deadline` is a time on it. */
  now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private deadlineError(url: URL, deadline: number | undefined, cut: boolean): DeadlineError {
    return new DeadlineError(
      cut
        ? `${url.host} was cut off at this call's deadline.`
        : `No time left before this call's deadline to ask ${url.host}.`,
      {
        status: 0,
        remedy: "Call again for what was not read; the request itself did not fail.",
        errors: { deadline },
      },
    );
  }

  /**
   * POST with the gate, a deadline, and a short retry on 429/5xx/network
   * errors. The body is read here, inside the same deadline and error mapping:
   * a server that sends headers and then stalls must time out like one that
   * never answers. A timeout is NOT retried, so the worst case stays near one
   * deadline instead of a multiple that outlives the MCP client's own timeout.
   * An absolute `deadline` (RequestOptions) bounds the whole thing, retries and
   * backoff included.
   */
  private async post(
    url: URL,
    body: string,
    headers: Record<string, string>,
    { deadline }: RequestOptions = {},
  ): Promise<{ res: Response; bytes: Uint8Array }> {
    // Infinity without a deadline, which makes every check below a no-op.
    const left = (): number => (deadline === undefined ? Infinity : deadline - this.now());
    /** Wait `delay` then retry, unless that would leave too little time before the deadline. */
    const canRetry = (delay: number): boolean => left() - delay >= MIN_ATTEMPT_MS;
    let attempt = 0;
    for (;;) {
      // Checked before and after the gate, which can itself wait a second or more.
      if (left() < MIN_ATTEMPT_MS) throw this.deadlineError(url, deadline, false);
      await this.gate();
      const timeLeft = left();
      if (timeLeft < MIN_ATTEMPT_MS) throw this.deadlineError(url, deadline, false);
      // The deadline, not timeoutMs, ends this attempt when it comes first.
      const cutByDeadline = timeLeft < this.opts.timeoutMs;
      const attemptMs = Math.min(this.opts.timeoutMs, timeLeft);
      this.logger?.debug?.(`POST ${url.host}${url.pathname}${url.search} (attempt ${attempt + 1})`);
      let res: Response;
      let bytes: Uint8Array;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(attemptMs),
        });
        if ((res.status === 429 || res.status >= 500) && attempt < this.opts.maxRetries) {
          const delay = retryAfterMs(res) ?? backoffMs(attempt);
          if (!canRetry(delay)) {
            await res.body?.cancel();
            throw this.deadlineError(url, deadline, false);
          }
          this.logger?.warn?.(`HTTP ${res.status}, retrying in ${delay}ms`);
          await res.body?.cancel();
          await new Promise((r) => setTimeout(r, delay));
          attempt += 1;
          continue;
        }
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (err instanceof DeadlineError) throw err; // from the retry check above
        const timedOut =
          err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (timedOut && cutByDeadline) throw this.deadlineError(url, deadline, true);
        if (!timedOut && attempt < this.opts.maxRetries) {
          if (!canRetry(backoffMs(attempt))) {
            throw this.deadlineError(url, deadline, false);
          }
          this.logger?.warn?.(`network error (${String(err)}), retrying`);
          await new Promise((r) => setTimeout(r, backoffMs(attempt)));
          attempt += 1;
          continue;
        }
        throw new GeneanetApiError(
          timedOut
            ? `${url.host} did not answer within ${this.opts.timeoutMs} ms`
            : `${url.host} is unreachable: ${err instanceof Error ? err.message : String(err)}`,
          { status: 0, remedy: "Check the network, then retry once. Do not loop on this." },
        );
      }
      return { res, bytes };
    }
  }

  /**
   * Call one family-tree API operation. Returns undefined when Geneanet answers
   * with an empty body, which is what both "no such person" and "no such
   * operation" look like: the API does not tell them apart.
   */
  async treeApi(
    op: string,
    tree: string,
    message: Uint8Array,
    opts: RequestOptions = {},
  ): Promise<ProtoMessage | undefined> {
    const url = new URL(`${this.opts.treeBaseUrl}/setup/api/`);
    url.searchParams.set("arbre", op);
    url.searchParams.set("sourcename", tree);
    url.searchParams.set("lang", this.opts.lang);
    url.searchParams.set("type", "");
    const { res, bytes: body } = await this.post(
      url,
      frameRequest(message),
      {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "*/*",
        "X-Requested-With": "XMLHttpRequest",
      },
      opts,
    );

    if (!res.ok) {
      const text = new TextDecoder().decode(body.subarray(0, 2000));
      if (isChallenge(res, text)) throw this.blocked(url);
      if (res.status === 400 && text.includes("Basename not found")) {
        throw new GeneanetApiError(`There is no Geneanet tree named "${tree}".`, {
          status: 404,
          remedy:
            "A tree name is the first path segment of its URL: gw.geneanet.org/<tree>. Take it " +
            "from a geneanet_search_records result (its `tree` field) rather than guessing.",
        });
      }
      throw new GeneanetApiError(`${op} on tree ${tree} failed: HTTP ${res.status}`, {
        status: res.status,
        ...(res.status === 429
          ? { remedy: "Geneanet is rate limiting. Wait a minute before the next call." }
          : {}),
        errors: text.slice(0, 300),
      });
    }
    if (body.length === 0) return undefined;

    let decoded: ProtoMessage;
    try {
      decoded = new ProtoMessage(unframeResponse(body));
    } catch (err) {
      if (err instanceof ProtoDecodeError) {
        throw new GeneanetApiError(`${op} answered something that is not a GeneWeb message.`, {
          status: 502,
          remedy:
            "Geneanet may have changed its API. Report it; retrying will not help. " +
            `(${err.message})`,
        });
      }
      throw err;
    }
    const apiError = decodeApiError(decoded);
    if (apiError) {
      throw new GeneanetApiError(
        `${op} on tree ${tree} was refused: ${apiError.message ?? `code ${apiError.code}`}`,
        {
          status: apiError.code,
          ...(apiError.code === 403 || apiError.code === 401
            ? { remedy: "This tree or person is private; only its owner can read it." }
            : {}),
        },
      );
    }
    return decoded;
  }

  /** Fetch one page of the site-wide individuals search, as HTML. */
  async searchRecordsPage(params: URLSearchParams, opts: RequestOptions = {}): Promise<string> {
    const url = new URL(`${this.opts.siteBaseUrl}/fonds/individus/`);
    url.search = params.toString();
    const { res, bytes } = await this.post(
      url,
      "",
      {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "User-Agent": BROWSER_UA,
      },
      opts,
    );
    const text = new TextDecoder().decode(bytes);
    if (isChallenge(res, text)) throw this.blocked(url);
    if (!res.ok) {
      throw new GeneanetApiError(`The site-wide search failed: HTTP ${res.status}`, {
        status: res.status,
        ...(res.status === 429
          ? { remedy: "Geneanet is rate limiting. Wait a minute before the next call." }
          : {}),
      });
    }
    return text;
  }

  private blocked(url: URL): BlockedError {
    return new BlockedError(`Cloudflare challenged the request to ${url.host}${url.pathname}.`, {
      status: 403,
      remedy:
        "Geneanet's bot protection now blocks this route from outside a browser. Nothing in " +
        "this server can get past it; search on the website in Safari instead.",
    });
  }
}
