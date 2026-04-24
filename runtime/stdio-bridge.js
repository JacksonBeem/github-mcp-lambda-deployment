import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export class StdioBridge {
  constructor(command, args, options = {}) {
    this.command = command;
    this.args = args;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 45_000;
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? 20_000;
    this.child = null;
    this.buffer = "";
    this.pending = new Map();
    this.toolCache = null;
    this.initialized = false;
    this.initPromise = null;
    this.serialQueue = Promise.resolve();
  }

  async listTools() {
    return this.enqueue(async () => {
      await this.ensureReadyInternal();
      return this.toolCache ? [...this.toolCache] : [];
    });
  }

  async callTool(toolName, args) {
    return this.enqueue(async () => {
      await this.ensureReadyInternal();
      return this.sendRequest("tools/call", { name: toolName, arguments: args });
    });
  }

  kill() {
    this.invalidateBridge(new Error("Bridge killed"));
    this.initPromise = null;
  }

  enqueue(fn) {
    const next = this.serialQueue.then(fn, fn);
    this.serialQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async ensureReadyInternal() {
    if (this.initialized && this.child && this.isChildAlive()) return;
    if (!this.initPromise) {
      this.initPromise = this.spawnAndInitialize().finally(() => {
        this.initPromise = null;
      });
    }
    await this.initPromise;
  }

  async spawnAndInitialize() {
    this.invalidateBridge(new Error("Bridge reinitializing"));
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child = child;

    child.stdout?.on("data", (chunk) => {
      if (this.child !== child) return;
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    child.stderr?.on("data", (chunk) => {
      if (this.child !== child) return;
      console.error(`[github-mcp-stderr] ${chunk.toString().trim()}`);
    });

    child.on("error", (error) => {
      if (this.child !== child) return;
      this.invalidateBridge(new Error(`Official GitHub MCP server process error: ${error.message}`), child);
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this.invalidateBridge(new Error(`Official GitHub MCP server exited with ${reason}`), child, false);
    });

    await this.sendRequest(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "github-lambda-mcp", version: "0.1.0" },
      },
      this.spawnTimeoutMs,
    );
    this.sendNotification("notifications/initialized", {});
    const toolsResponse = await this.sendRequest("tools/list", {}, this.spawnTimeoutMs);
    const tools = toolsResponse.result?.tools;
    this.toolCache = Array.isArray(tools) ? tools : [];
    this.initialized = true;
  }

  sendNotification(method, params) {
    if (!this.child || !this.isChildAlive() || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("Official GitHub MCP server process is not running");
    }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  sendRequest(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.isChildAlive() || !this.child.stdin || this.child.stdin.destroyed) {
        reject(new Error("Official GitHub MCP server process is not running"));
        return;
      }

      const id = randomUUID();
      const timeout = timeoutMs ?? this.requestTimeoutMs;
      const activeChild = this.child;
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        const error = new Error(`Official GitHub MCP "${method}" timed out after ${timeout}ms`);
        this.pending.delete(id);
        pending.reject(error);
        this.invalidateBridge(error, activeChild);
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        const writeError = new Error(`Failed to write official GitHub MCP "${method}" request: ${error.message}`);
        reject(writeError);
        this.invalidateBridge(writeError, activeChild);
      });
    });
  }

  processBuffer() {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          pending.resolve(message);
        }
      } catch {
        console.error(`[github-mcp-parse] Non-JSON stdout line: ${line.slice(0, 200)}`);
        this.invalidateBridge(new Error("Failed to parse JSON from official GitHub MCP server stdout"));
      }
    }
  }

  isChildAlive() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  invalidateBridge(error, child = this.child, terminateChild = true) {
    this.initialized = false;
    this.buffer = "";
    this.toolCache = null;
    if (this.child === child) this.child = null;
    this.rejectPending(error);

    if (!terminateChild || !child || child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }, 3_000).unref?.();
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
