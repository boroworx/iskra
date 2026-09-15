// @effect-diagnostics nodeBuiltinImport:off - a plain HTTP server a provider binary connects to.
/**
 * A streamable-HTTP MCP server for provider probes. It serves fixed text tools and counts
 * every request, so a decoy that must never be contacted can assert zero.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

export interface FakeMcpServer {
  readonly url: string;
  /** Every HTTP request received, of any kind. */
  readonly requestCount: () => number;
  readonly toolCalls: ReadonlyArray<string>;
  readonly authorizationHeaders: ReadonlyArray<string | undefined>;
  readonly close: () => Promise<void>;
}

interface JsonRpcRequest {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: { readonly name?: string; readonly protocolVersion?: string };
}

/** `tools` maps a tool name to the text its call returns. */
export function startFakeMcpServer(
  tools: Readonly<Record<string, string>>,
): Promise<FakeMcpServer> {
  let requestCount = 0;
  const toolCalls: Array<string> = [];
  const authorizationHeaders: Array<string | undefined> = [];
  const answer = (message: JsonRpcRequest) => {
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1.0.0" },
        };
      case "tools/list":
        return {
          tools: Object.keys(tools).map((name) => ({
            name,
            description: `Probe tool ${name}.`,
            inputSchema: { type: "object", properties: {} },
          })),
        };
      case "tools/call": {
        const name = message.params?.name ?? "";
        toolCalls.push(name);
        return { content: [{ type: "text", text: tools[name] ?? `unknown tool ${name}` }] };
      }
      default:
        return {};
    }
  };
  const server = NodeHttp.createServer((request, response) => {
    requestCount += 1;
    authorizationHeaders.push(request.headers.authorization);
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(request.method === "DELETE" ? 200 : 405).end();
        return;
      }
      const message = JSON.parse(body) as JsonRpcRequest;
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fake" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message) }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        requestCount: () => requestCount,
        toolCalls,
        authorizationHeaders,
        close: () => {
          server.closeAllConnections();
          return new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}
