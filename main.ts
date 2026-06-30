#!/usr/bin/env node
/**
 * Entry point for the job-search MCP server.
 *
 * Claude Desktop launches this over stdio:  node dist/main.js
 * (dev: tsx main.ts). stdio is the only transport — there is no HTTP/web layer.
 *
 * IMPORTANT: never write to stdout except via the transport; stdout carries the
 * JSON-RPC stream. All diagnostics go to stderr (console.error).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
