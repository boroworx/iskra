// @effect-diagnostics nodeBuiltinImport:off - a plain HTTP server a provider binary connects to.
/**
 * A scripted OpenAI-compatible model for provider probes: chat completions (OpenCode) and a
 * minimal Responses stream (Codex). Each request is answered by `reply` and recorded.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

export interface FakeChatMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_call_id?: string;
}

export interface FakeModelRequest {
  readonly path: string;
  readonly messages: ReadonlyArray<FakeChatMessage>;
  readonly toolNames: ReadonlyArray<string>;
}

export type FakeModelReply =
  | { readonly toolCall: { readonly name: string; readonly arguments: object } }
  | { readonly text: string };

export interface FakeModelServer {
  readonly baseUrl: string;
  readonly requests: ReadonlyArray<FakeModelRequest>;
  readonly close: () => Promise<void>;
}

interface RawRequest {
  readonly stream?: boolean;
  readonly messages?: ReadonlyArray<FakeChatMessage>;
  readonly input?: ReadonlyArray<FakeChatMessage>;
  readonly tools?: ReadonlyArray<{ readonly name?: string; readonly function?: { name: string } }>;
}

let nextId = 0;
const newId = (prefix: string) => `${prefix}_${(nextId += 1)}`;

const sse = (response: NodeHttp.ServerResponse, events: ReadonlyArray<object | string>) => {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) {
    response.write(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
  }
  response.end();
};

function chatCompletion(response: NodeHttp.ServerResponse, reply: FakeModelReply, stream: boolean) {
  const id = newId("chatcmpl");
  const toolCalls =
    "toolCall" in reply
      ? [
          {
            index: 0,
            id: newId("call"),
            type: "function",
            function: {
              name: reply.toolCall.name,
              arguments: JSON.stringify(reply.toolCall.arguments),
            },
          },
        ]
      : undefined;
  const finish = toolCalls ? "tool_calls" : "stop";
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const base = { id, created: 0, model: "fake" };
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "text" in reply ? reply.text : null,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finish,
          },
        ],
        usage,
      }),
    );
    return;
  }
  const delta = toolCalls
    ? { role: "assistant", tool_calls: toolCalls }
    : { role: "assistant", content: "text" in reply ? reply.text : "" };
  sse(response, [
    {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: null }],
    },
    {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage,
    },
    "[DONE]",
  ]);
}

// ponytail: the smallest Responses stream Codex accepts in its tests; unverified here (no binary).
function responsesStream(response: NodeHttp.ServerResponse, reply: FakeModelReply) {
  const id = newId("resp");
  const item =
    "toolCall" in reply
      ? {
          type: "function_call",
          id: `fc_${id}`,
          call_id: `call_${id}`,
          name: reply.toolCall.name,
          arguments: JSON.stringify(reply.toolCall.arguments),
        }
      : {
          type: "message",
          id: `msg_${id}`,
          role: "assistant",
          content: [{ type: "output_text", text: reply.text }],
        };
  sse(response, [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

export function startFakeModelServer(
  reply: (request: FakeModelRequest) => FakeModelReply,
): Promise<FakeModelServer> {
  const requests: Array<FakeModelRequest> = [];
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const path = (request.url ?? "").split("?")[0] ?? "";
      if (request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const raw = JSON.parse(body) as RawRequest;
      const recorded: FakeModelRequest = {
        path,
        messages: raw.messages ?? raw.input ?? [],
        toolNames: (raw.tools ?? []).flatMap((tool) => tool.function?.name ?? tool.name ?? []),
      };
      requests.push(recorded);
      if (path.endsWith("/chat/completions")) {
        chatCompletion(response, reply(recorded), raw.stream === true);
      } else if (path.endsWith("/responses")) {
        responsesStream(response, reply(recorded));
      } else {
        response.writeHead(404).end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => {
          server.closeAllConnections();
          return new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}
