import { readFileSync } from "node:fs";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { vi } from "vitest";

import { loadConfig, type Config } from "#/config";
import { createServer } from "#/server";

// The server reads no credential or config file, so loadConfig(env) cannot
// pick up the developer's own setup: the env passed here is all it sees.

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** A real response body captured from Geneanet (see test/fixtures). */
export const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(name, FIXTURES)));

export const fixtureText = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");

export const binResponse = (body: Uint8Array, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "application/octet-stream" } });

export const htmlResponse = (
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8", ...headers },
  });

export type FetchLike = (url: unknown, init?: unknown) => Promise<Response>;

export type Call = { url: URL; body: string; method: string };

export const connect = async (env: Record<string, string> = {}, impl?: FetchLike) => {
  const config: Config = loadConfig(env);
  const calls: Call[] = [];
  const fetchMock = vi.fn<FetchLike>(async (url, init) => {
    const i = (init ?? {}) as RequestInit;
    calls.push({
      url: new URL(String(url)),
      body: String(i.body ?? ""),
      method: i.method ?? "GET",
    });
    return impl ? impl(url, init) : binResponse(new Uint8Array());
  });
  const { server } = createServer({
    config,
    fetch: fetchMock as unknown as typeof fetch,
    gate: async () => {},
  });

  // Both halves of a linked pair must come from the SAME package: v2 exports
  // InMemoryTransport from both /client and /server, and the two copies keep
  // private state that does not cross. Mixing them makes the pair hang rather
  // than fail, which is a miserable thing to debug.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    /** Plain data, never the mock: a vitest mock in the return type fails tsc with TS2883. */
    calls: (): Call[] => calls,
    toolNames: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tool: async (name: string) => (await client.listTools()).tools.find((t) => t.name === name),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      // A schema violation never reaches the tool body. SDK 2.4 answers with an
      // isError result whose text starts "Input validation error"; older builds
      // threw. Both are reported as `rejected`.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) } as Record<string, unknown>;
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      if (res.isError === true && text.startsWith("Input validation error")) {
        return { isToolError: true, rejected: true, error: text } as Record<string, unknown>;
      }
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true } as Record<
          string,
          unknown
        >;
      } catch {
        return { isToolError: res.isError === true, error: text } as Record<string, unknown>;
      }
    },
  };
};

/** Route a mocked request by the tree API's `arbre` operation. */
export const byOperation =
  (routes: Record<string, () => Response>): FetchLike =>
  async (url) => {
    const u = new URL(String(url));
    const op = u.searchParams.get("arbre");
    const route = op ? routes[op] : routes[u.pathname];
    if (!route) throw new Error(`unexpected request ${u.toString()}`);
    return route();
  };
