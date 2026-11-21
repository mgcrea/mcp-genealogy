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

import { BlockedError, GeneanetApiError } from "#/client/errors";
import type { Logger } from "#/client/log";
import { decodeApiError } from "#/proto/messages";
import { ProtoDecodeError, ProtoMessage, frameRequest, unframeResponse } from "#/proto/wire";

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

  /**
   * POST with the gate, a deadline, and a short retry on 429/5xx/network
   * errors. The body is read here, inside the same deadline and error mapping:
   * a server that sends headers and then stalls must time out like one that
   * never answers. A timeout is NOT retried, so the worst case stays near one
   * deadline instead of a multiple that outlives the MCP client's own timeout.
   */
  private async post(
    url: URL,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ res: Response; bytes: Uint8Array }> {
    let attempt = 0;
    for (;;) {
      await this.gate();
      this.logger?.debug?.(`POST ${url.host}${url.pathname}${url.search} (attempt ${attempt + 1})`);
      let res: Response;
      let bytes: Uint8Array;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        if ((res.status === 429 || res.status >= 500) && attempt < this.opts.maxRetries) {
          const delay = retryAfterMs(res) ?? backoffMs(attempt);
          this.logger?.warn?.(`HTTP ${res.status}, retrying in ${delay}ms`);
          await res.body?.cancel();
          await new Promise((r) => setTimeout(r, delay));
          attempt += 1;
          continue;
        }
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        const timedOut =
          err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (!timedOut && attempt < this.opts.maxRetries) {
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
  async treeApi(op: string, tree: string, message: Uint8Array): Promise<ProtoMessage | undefined> {
    const url = new URL(`${this.opts.treeBaseUrl}/setup/api/`);
    url.searchParams.set("arbre", op);
    url.searchParams.set("sourcename", tree);
    url.searchParams.set("lang", this.opts.lang);
    url.searchParams.set("type", "");
    const { res, bytes: body } = await this.post(url, frameRequest(message), {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "*/*",
      "X-Requested-With": "XMLHttpRequest",
    });

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
  async searchRecordsPage(params: URLSearchParams): Promise<string> {
    const url = new URL(`${this.opts.siteBaseUrl}/fonds/individus/`);
    url.search = params.toString();
    const { res, bytes } = await this.post(url, "", {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
      "User-Agent": BROWSER_UA,
    });
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
