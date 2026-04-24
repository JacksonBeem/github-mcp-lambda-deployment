import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { StdioBridge } from "./stdio-bridge.js";

const AUTH_HEADER = process.env.MCP_AUTH_HEADER ?? "x-mcp-auth";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
const ALLOWED_ORIGINS = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const SERVER_NAME = process.env.MCP_SERVER_NAME ?? "github-lambda-mcp";
const SERVER_VERSION = process.env.MCP_SERVER_VERSION ?? "0.1.0";
const SERVER_SOURCE_PATH =
  process.env.GITHUB_MCP_SERVER_PATH ?? join(process.cwd(), "bin", "github-mcp-server");
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? "45000");
const SPAWN_TIMEOUT_MS = Number(process.env.MCP_SPAWN_TIMEOUT_MS ?? "20000");

let bridge;
let preparedCommand;

function headerValue(event, name) {
  const headers = event.headers ?? {};
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

function rawPathParts(event) {
  const rawPath = event.rawPath ?? event.path ?? "";
  const stage = event.requestContext?.stage;
  const parts = rawPath.split("/").filter(Boolean);
  return stage && parts[0] === stage ? parts.slice(1) : parts;
}

function httpMethod(event) {
  return (event.requestContext?.http?.method ?? event.httpMethod ?? "").toUpperCase();
}

function jsonResponse(statusCode, body, headers = {}) {
  const responseHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": `content-type,${AUTH_HEADER},mcp-session-id`,
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    ...headers,
  };

  return {
    statusCode,
    headers: responseHeaders,
    body: body === undefined || body === null ? "" : JSON.stringify(body),
  };
}

function withDuration(startMs, headers = {}) {
  return {
    ...headers,
    "X-Duration-Ms": (performance.now() - startMs).toFixed(2),
  };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function decodeBody(event) {
  if (!event.body) return "";
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf8");
  }
  return event.body;
}

function parseJsonBody(event) {
  const body = decodeBody(event);
  if (!body) {
    throw new Error("Missing body");
  }
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Body must be a single JSON-RPC object");
  }
  return parsed;
}

function validateRequest(event, pathParts) {
  const method = httpMethod(event);

  if (method === "OPTIONS") {
    return jsonResponse(204, null);
  }

  if (pathParts.length === 1 && pathParts[0] === "health") {
    if (method !== "GET") {
      return jsonResponse(405, { message: "Method Not Allowed" }, { Allow: "GET" });
    }
    return null;
  }

  const isMcpPath =
    pathParts.length === 1 && pathParts[0] === "mcp";
  if (!isMcpPath) {
    return jsonResponse(404, { message: "Not Found" });
  }

  if (method !== "POST") {
    return jsonResponse(405, { message: "Method Not Allowed" }, { Allow: "POST" });
  }

  if (AUTH_TOKEN && headerValue(event, AUTH_HEADER) !== AUTH_TOKEN) {
    return jsonResponse(401, { message: "Unauthorized" });
  }

  const origin = headerValue(event, "origin");
  if (ALLOWED_ORIGINS.size > 0 && origin && !ALLOWED_ORIGINS.has(origin)) {
    return jsonResponse(403, { message: "Forbidden (origin)" });
  }

  return null;
}

function prepareExecutable() {
  if (preparedCommand) return preparedCommand;
  if (!existsSync(SERVER_SOURCE_PATH)) {
    throw new Error(`Official GitHub MCP server binary not found at ${SERVER_SOURCE_PATH}`);
  }

  // Lambda deployment packages are read-only and Windows-built zips can lose
  // executable mode bits, so copy to /tmp and chmod before spawning.
  const tmpDir = process.env.AWS_LAMBDA_FUNCTION_NAME ? "/tmp/github-mcp-server-bin" : join(process.cwd(), ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpCommand = join(tmpDir, basename(SERVER_SOURCE_PATH));
  copyFileSync(SERVER_SOURCE_PATH, tmpCommand);
  chmodSync(tmpCommand, 0o755);
  preparedCommand = tmpCommand;
  return preparedCommand;
}

function getBridge() {
  if (bridge) return bridge;
  const command = prepareExecutable();
  bridge = new StdioBridge(command, ["stdio"], {
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    spawnTimeoutMs: SPAWN_TIMEOUT_MS,
  });
  return bridge;
}

async function handleHealth(startMs) {
  const binaryExists = existsSync(SERVER_SOURCE_PATH);
  return jsonResponse(
    200,
    {
      status: binaryExists ? "ok" : "missing_binary",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      officialServerPath: SERVER_SOURCE_PATH,
      officialServerPresent: binaryExists,
      githubTokenConfigured: Boolean(process.env.GITHUB_PERSONAL_ACCESS_TOKEN),
      toolsets: process.env.GITHUB_TOOLSETS ?? "",
      readOnly: process.env.GITHUB_READ_ONLY ?? "",
    },
    withDuration(startMs),
  );
}

async function handleMcp(event, startMs, lambdaRequestId) {
  let rpcRequest;
  try {
    rpcRequest = parseJsonBody(event);
  } catch (error) {
    return jsonResponse(
      400,
      jsonRpcError(null, -32700, "Parse error", error instanceof Error ? error.message : String(error)),
      withDuration(startMs),
    );
  }

  if (rpcRequest.jsonrpc !== "2.0" || typeof rpcRequest.method !== "string") {
    return jsonResponse(400, jsonRpcError(rpcRequest.id, -32600, "Invalid Request"), withDuration(startMs));
  }

  const id = rpcRequest.id;
  const isNotification = id === undefined || id === null;
  const params = rpcRequest.params ?? {};

  try {
    if (rpcRequest.method === "ping") {
      return isNotification
        ? jsonResponse(202, null, withDuration(startMs))
        : jsonResponse(200, jsonRpcResult(id, {}), withDuration(startMs));
    }

    if (rpcRequest.method === "initialize") {
      return jsonResponse(
        200,
        jsonRpcResult(id, {
          protocolVersion: "2025-06-18",
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: { listChanged: false } },
        }),
        withDuration(startMs, { "X-Lambda-Request-Id": lambdaRequestId }),
      );
    }

    if (rpcRequest.method === "notifications/initialized") {
      return jsonResponse(202, null, withDuration(startMs));
    }

    if (rpcRequest.method === "tools/list") {
      if (isNotification) return jsonResponse(202, null, withDuration(startMs));
      const tools = await getBridge().listTools();
      return jsonResponse(200, jsonRpcResult(id, { tools }), withDuration(startMs));
    }

    if (rpcRequest.method === "tools/call") {
      if (isNotification) return jsonResponse(202, null, withDuration(startMs));
      const name = params.name;
      const args = params.arguments ?? {};
      if (typeof name !== "string" || !name.trim() || !args || typeof args !== "object" || Array.isArray(args)) {
        return jsonResponse(400, jsonRpcError(id, -32602, "Invalid params"), withDuration(startMs));
      }
      const response = await getBridge().callTool(name, args);
      if (response.error) {
        return jsonResponse(200, jsonRpcError(id, response.error.code, response.error.message, response.error.data), withDuration(startMs));
      }
      return jsonResponse(200, jsonRpcResult(id, response.result ?? {}), withDuration(startMs));
    }

    if (rpcRequest.method === "logging/setLevel") {
      return isNotification
        ? jsonResponse(202, null, withDuration(startMs))
        : jsonResponse(200, jsonRpcResult(id, {}), withDuration(startMs));
    }

    return jsonResponse(400, jsonRpcError(id, -32601, `Method not found: ${rpcRequest.method}`), withDuration(startMs));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      500,
      jsonRpcError(id, -32603, "Internal error", {
        message,
        requestId: lambdaRequestId,
      }),
      withDuration(startMs),
    );
  }
}

export async function handler(event, context = {}) {
  const startMs = performance.now();
  const lambdaRequestId = context.awsRequestId ?? randomUUID();
  const pathParts = rawPathParts(event);
  const validationResponse = validateRequest(event, pathParts);
  if (validationResponse) return validationResponse;

  if (pathParts.length === 1 && pathParts[0] === "health") {
    return handleHealth(startMs);
  }

  return handleMcp(event, startMs, lambdaRequestId);
}
