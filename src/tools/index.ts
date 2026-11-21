import type { McpServer } from "@modelcontextprotocol/server";

import type { PersonCache } from "#/cache";
import type { Config } from "#/config";
import type { GeneanetClient } from "#/sources/geneanet/geneanet";
import { registerExportTools } from "#/tools/export";
import { registerRecordsTools } from "#/tools/records";
import { registerStatusTools } from "#/tools/status";
import { registerTreeTools } from "#/tools/trees";

export type ToolContext = {
  config: Config;
  cache: PersonCache;
};

/**
 * Register the tools. There is nothing to gate: no tool needs credentials and
 * none writes to a source. The only write is genealogy_export_gedcom's file,
 * confined to `config.exportDir`. Geneanet's tree-editing API (`api_saisie_write.proto`) is real,
 * but no tool reaches it, on purpose. Adding one would mean adding the fleet's
 * GENEANET_ALLOW_WRITES non-registration gate first.
 */
export const registerTools = (
  server: McpServer,
  client: GeneanetClient,
  ctx: ToolContext,
): void => {
  registerStatusTools(server, client, ctx);
  registerRecordsTools(server, client);
  registerTreeTools(server, client, ctx);
  registerExportTools(server, client, ctx);
};
