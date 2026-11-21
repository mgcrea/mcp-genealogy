#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ZodError } from "zod";

import { BUILD_INFO } from "#/build-info";
import { loadConfig } from "#/config";
import { createServer } from "#/server";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray
// log line there corrupts the stream.
// GENEANET_DEBUG is the name from before the rename, still accepted.
const debug = Boolean(process.env.GENEALOGY_DEBUG || process.env.GENEANET_DEBUG);
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (debug) console.error("[genealogy-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[genealogy-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[genealogy-mcp]", ...args),
};

/** Show a config mistake as its field messages, not 40 frames of zod internals. */
const describeFatal = (err: unknown): string => {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const config = loadConfig();
  const { server } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  stderrLogger.warn(
    `genealogy-mcp connected (read-only toward sources, no credentials; tree=${config.tree ?? "none"}, ` +
      `lang=${config.lang}, pacing=${config.minIntervalMs}ms)`,
  );
  for (const line of config.adjusted) stderrLogger.warn(line);

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error(`[genealogy-mcp] fatal: ${describeFatal(err)}`);
  process.exit(1);
});
