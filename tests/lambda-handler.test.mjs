import assert from "node:assert/strict";
import { handler } from "../runtime/lambda-handler.js";

function event(body, path = "/mcp", method = "POST") {
  return {
    version: "2.0",
    rawPath: path,
    headers: { "content-type": "application/json" },
    requestContext: {
      requestId: "test-request",
      http: { method, path },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

async function testInitialize() {
  const response = await handler(
    event({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    { awsRequestId: "unit-test" },
  );

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.result.serverInfo.name, "github-lambda-mcp");
  assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
}

async function testHealth() {
  const response = await handler(event(undefined, "/health", "GET"), { awsRequestId: "unit-test" });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(typeof body.officialServerPresent, "boolean");
  assert.equal(body.server, "github-lambda-mcp");
}

async function testUnknownMethod() {
  const response = await handler(
    event({ jsonrpc: "2.0", id: 2, method: "nope", params: {} }),
    { awsRequestId: "unit-test" },
  );

  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.error.code, -32601);
}

await testInitialize();
await testHealth();
await testUnknownMethod();
console.log("lambda-handler tests passed");
