import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { GeneanetClient } from "#/client/geneanet";
import type { Logger } from "#/client/log";
import type { Config } from "#/config";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the request pacing (tests pass a no-op). */
  gate?: () => Promise<void>;
};

export type CreatedServer = {
  server: McpServer;
  client: GeneanetClient;
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
  });

  registerTools(server, client, { config });
  return { server, client };
};
