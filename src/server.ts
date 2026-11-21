import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { PersonCache } from "#/cache";
import type { Config } from "#/config";
import type { Logger } from "#/log";
import { GeneanetClient } from "#/sources/geneanet/geneanet";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the request pacing (tests pass a no-op). */
  gate?: () => Promise<void>;
  /** The clock request deadlines are read on (tests pass a fake). Defaults to Date.now. */
  now?: () => number;
};

export type CreatedServer = {
  server: McpServer;
  client: GeneanetClient;
  /** People fetched so far, shared by every tool of this server. */
  cache: PersonCache;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new GeneanetClient({
    treeBaseUrl: config.treeBaseUrl,
    siteBaseUrl: config.siteBaseUrl,
    lang: config.lang,
    minIntervalMs: config.minIntervalMs,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.gate ? { gate: opts.gate } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  const cache = new PersonCache();
  registerTools(server, client, { config, cache });
  return { server, client, cache };
};
