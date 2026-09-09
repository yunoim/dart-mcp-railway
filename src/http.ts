#!/usr/bin/env node
/**
 * Remote (HTTP) entrypoint for Railway.
 *
 * Upstream ships stdio only (src/index.ts). This wires the same createServer()
 * to a Streamable HTTP transport so it can be used as a remote MCP server.
 * No tool implementation is touched.
 *
 *   POST   /mcp      MCP requests
 *   GET    /mcp      SSE stream (needs a session)
 *   DELETE /mcp      end session
 *   GET    /healthz
 */
import "dotenv/config";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server/mcp-server.js";
import { SERVER_NAME, VERSION } from "./version.js";

const PORT = Number(process.env.PORT ?? 8080);
const PATHNAME = process.env.MCP_PATH ?? "/mcp";
/** When set, requires Authorization: Bearer <token>. Unset = public. */
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
/** Where the corp_code sqlite cache lives inside the container. */
const CACHE_DIR = process.env.CORP_CODE_CACHE_DIR ?? "/tmp/korean-dart-mcp";

const apiKey = process.env.DART_API_KEY;
if (!apiKey) {
  console.error(
    `[${SERVER_NAME}] DART_API_KEY is not set.\n` +
      `Railway -> this service -> Variables -> reference the project variable.`,
  );
  process.exit(1);
}

/** session id -> transport */
const sessions = new Map<string, StreamableHTTPServerTransport>();

// createServer() builds the corp_code init promise internally and rethrows on
// failure. If a session closes before any tool call, nobody awaits that
// rejection and Node kills the process. Log it and stay alive instead.
process.on("unhandledRejection", (reason) => {
  console.error(`[${SERVER_NAME}] unhandledRejection:`, reason);
});

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
  });
  res.end(payload);
}

function unauthorized(res: ServerResponse) {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="mcp"',
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    }),
  );
}

function authorized(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true;
  const h = req.headers.authorization;
  return typeof h === "string" && h.startsWith("Bearer ") && h.slice(7).trim() === AUTH_TOKEN;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

const http = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/healthz") {
    return send(res, 200, { ok: true, server: SERVER_NAME, version: VERSION, sessions: sessions.size });
  }

  if (url.pathname === "/") {
    return send(
      res,
      200,
      `${SERVER_NAME} v${VERSION}\nMCP endpoint: ${PATHNAME}\nauth: ${AUTH_TOKEN ? "bearer" : "none"}\n`,
    );
  }

  if (url.pathname !== PATHNAME) {
    return send(res, 404, { error: "not found" });
  }

  if (!authorized(req)) return unauthorized(res);

  const sessionId = req.headers["mcp-session-id"];
  const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

  try {
    // existing session
    if (sid && sessions.has(sid)) {
      const transport = sessions.get(sid)!;
      const body = req.method === "POST" ? await readBody(req) : undefined;
      return void (await transport.handleRequest(req, res, body));
    }

    // no session + POST must be initialize
    if (req.method !== "POST") {
      return send(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "No session. POST initialize first." },
        id: null,
      });
    }

    const body = await readBody(req);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        console.error(`[${SERVER_NAME}] session open ${id} (${sessions.size} total)`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        console.error(`[${SERVER_NAME}] session close ${transport.sessionId} (${sessions.size} total)`);
      }
    };

    // One Server instance per session (SDK binds one transport per server).
    // CorpCodeResolver shares the sqlite cache, so no re-download.
    const server = createServer({ apiKey, cacheDir: CACHE_DIR });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error(`[${SERVER_NAME}] request error:`, err);
    if (!res.headersSent) {
      send(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        id: null,
      });
    }
  }
});

http.listen(PORT, () => {
  console.error(
    `[${SERVER_NAME}] v${VERSION} listening on :${PORT}${PATHNAME} (auth: ${AUTH_TOKEN ? "bearer" : "none"})`,
  );
  // Warm the corp_code dump (~1.5MB zip -> sqlite) at boot so the first
  // user's first tool call doesn't pay for it.
  createServer({ apiKey, cacheDir: CACHE_DIR });
  console.error(`[${SERVER_NAME}] warming corp_code cache (${CACHE_DIR})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.error(`[${SERVER_NAME}] ${sig} received, shutting down`);
    http.close(() => process.exit(0));
  });
}
