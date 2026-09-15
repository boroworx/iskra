// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - drives provider binaries through real files, git and JSON config.
/**
 * Real-binary probes of what a provider enforces for an Iskra run, gated on the binary being
 * installed. Models and MCP servers are local fakes, so nothing leaves the machine and no
 * credentials are used. Findings: docs/findings/m2-opencode-run-enforcement.md and
 * docs/findings/m2-codex-run-enforcement.md.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";
import {
  EnvironmentId,
  OpenCodeSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRunRestrictions,
  type ProviderRuntimeEvent,
} from "@iskra/contracts";
import { createModelSelection } from "@iskra/shared/model";

import * as ServerConfig from "../src/config.ts";
import * as McpProviderSession from "../src/mcp/McpProviderSession.ts";
import { makeOpenCodeAdapter } from "../src/provider/Layers/OpenCodeAdapter.ts";
import { OpenCodeRuntimeLive } from "../src/provider/opencodeRuntime.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { startFakeMcpServer, type FakeMcpServer } from "./fixtures/fakeMcpServer.ts";
import {
  startFakeModelServer,
  type FakeChatMessage,
  type FakeModelRequest,
} from "./fixtures/fakeModelServer.ts";

function binaryOnPath(name: string): string | undefined {
  const found = NodeChildProcess.spawnSync(
    NodeOS.platform() === "win32" ? "where" : "which",
    [name],
    {
      encoding: "utf8",
    },
  );
  return found.status === 0 ? found.stdout.trim().split("\n")[0] : undefined;
}

const textOf = (message: FakeChatMessage | undefined): string =>
  typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
      ? message.content
          .map((part: { readonly text?: unknown }) =>
            typeof part.text === "string" ? part.text : "",
          )
          .join("")
      : "";

const opencodeBinary = binaryOnPath("opencode");
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);
const localSettings = decodeOpenCodeSettings({ binaryPath: opencodeBinary ?? "opencode" });
const externalSettings = decodeOpenCodeSettings({
  binaryPath: opencodeBinary ?? "opencode",
  serverUrl: "http://127.0.0.1:9",
});

describe.skipIf(opencodeBinary === undefined)("OpenCode run enforcement (real binary)", () => {
  // Live clock: the adapter's own timeouts and reconciliation sleeps must elapse.
  it.live(
    "confines a run to its rules, its directory and Iskra's MCP server",
    () =>
      Effect.gen(function* () {
        const binaryPath = opencodeBinary ?? "opencode";
        const version = NodeChildProcess.execFileSync(binaryPath, ["--version"], {
          encoding: "utf8",
        }).trim();
        yield* Effect.logInfo(`OpenCode ${version}`);

        const root = yield* Effect.acquireRelease(
          // OpenCode resolves the session directory, so paths outside a symlinked tmpdir
          // (/var -> /private/var on macOS) would read as external.
          Effect.sync(() =>
            NodeFS.realpathSync(
              NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "iskra-oc-probe-")),
            ),
          ),
          (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
        );
        const at = (...parts: Array<string>) => NodePath.join(root, ...parts);
        const write = (file: string, content: string) => {
          NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
          NodeFS.writeFileSync(file, content);
        };

        const servers: Array<{ readonly close: () => Promise<void> }> = [];
        const track = <A extends { readonly close: () => Promise<void> }>(start: Promise<A>) =>
          Effect.promise(() => start).pipe(
            Effect.tap((server) => Effect.sync(() => servers.push(server))),
          );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => Promise.all(servers.map((server) => server.close()))),
        );

        const iskra = yield* track(startFakeMcpServer({ probe_tool: "PROBE_TOOL_OK" }));
        const canary = yield* track(startFakeMcpServer({}));
        const decoys: Record<string, FakeMcpServer> = {};
        for (const name of ["user", "home", "project", "dotdir", "configFile", "configContent"]) {
          decoys[name] = yield* track(startFakeMcpServer({ decoy_tool: "DECOY" }));
        }
        const decoyEntry = (name: string) => ({
          [`decoy_${name}`]: { type: "remote", url: decoys[name]!.url, enabled: true },
        });

        const repo = at("repo");
        const holdout = at("iskra", "userdata", "holdouts", "p.json");
        const outside = at("outside.txt");
        const bashMarker = at("bash-ran");
        const taskMarker = at("task-ran");
        write(NodePath.join(repo, "src", "a.ts"), "export const marker = 'A_TS_CONTENT';\n");
        write(
          NodePath.join(repo, "opencode.json"),
          JSON.stringify({ mcp: decoyEntry("project"), permission: { "*": "allow" } }),
        );
        write(
          NodePath.join(repo, ".opencode", "opencode.json"),
          JSON.stringify({ mcp: decoyEntry("dotdir") }),
        );
        NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: repo });
        write(holdout, JSON.stringify({ body: "HOLDOUT_SECRET" }));
        write(
          at("home", ".opencode", "opencode.json"),
          JSON.stringify({ mcp: decoyEntry("home") }),
        );
        write(
          at("userconfig", "opencode", "opencode.json"),
          JSON.stringify({ mcp: decoyEntry("user") }),
        );
        write(at("extra.json"), JSON.stringify({ mcp: decoyEntry("configFile") }));

        const steps: Record<string, { readonly name: string; readonly arguments: object }> = {
          readRepo: { name: "read", arguments: { filePath: NodePath.join(repo, "src", "a.ts") } },
          readHoldout: { name: "read", arguments: { filePath: holdout } },
          writeRepo: {
            name: "write",
            arguments: { filePath: NodePath.join(repo, "x.txt"), content: "written by run" },
          },
          writeOutside: { name: "write", arguments: { filePath: outside, content: "escaped" } },
          bash: {
            name: "bash",
            arguments: { command: `touch ${bashMarker}`, description: "probe" },
          },
          webfetch: { name: "webfetch", arguments: { url: canary.url, format: "text" } },
          task: {
            name: "task",
            arguments: {
              description: "probe",
              prompt: `Create the file ${taskMarker}`,
              subagent_type: "general",
            },
          },
          iskra: { name: "iskra_probe_tool", arguments: {} },
        };
        const model = yield* track(
          startFakeModelServer((request) => {
            // Title and summary requests carry no tools.
            if (request.toolNames.length === 0) return { text: "Probe" };
            const last = request.messages.at(-1);
            if (last?.role === "tool") return { text: "done" };
            const step = steps[/PROBE (\w+)/.exec(textOf(last))?.[1] ?? ""];
            return step ? { toolCall: step } : { text: "no step" };
          }),
        );

        const userEnvironment: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          HOME: at("home"),
          XDG_CONFIG_HOME: at("userconfig"),
          XDG_DATA_HOME: at("data"),
          XDG_CACHE_HOME: at("cache"),
          XDG_STATE_HOME: at("state"),
          OPENCODE_CONFIG: at("extra.json"),
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            mcp: decoyEntry("configContent"),
            provider: {
              iskraprobe: {
                npm: "@ai-sdk/openai-compatible",
                name: "Iskra probe",
                options: { baseURL: model.baseUrl, apiKey: "probe" },
                models: {
                  fake: { name: "Fake", tool_call: true, limit: { context: 100000, output: 4096 } },
                },
              },
            },
          }),
        };

        const instanceId = ProviderInstanceId.make("opencode");
        const adapter = yield* makeOpenCodeAdapter(localSettings, { environment: userEnvironment });
        const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
        const seen: Array<ProviderRuntimeEvent> = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => seen.push(event)).pipe(Effect.andThen(Queue.offer(events, event))),
        ).pipe(Effect.forkScoped);

        const modelSelection = createModelSelection(instanceId, "iskraprobe/fake");
        const startRun = (name: string, run: ProviderRunRestrictions, resumeCursor?: unknown) => {
          const threadId = ThreadId.make(`probe-${name}`);
          McpProviderSession.setMcpProviderSession({
            environmentId: EnvironmentId.make("probe"),
            threadId,
            providerSessionId: `probe-${name}`,
            providerInstanceId: instanceId,
            endpoint: iskra.url,
            authorizationHeader: "Bearer probe-token",
            capabilities: new Set(),
          });
          return adapter
            .startSession({
              threadId,
              cwd: repo,
              runtimeMode: "full-access",
              modelSelection,
              run,
              ...(resumeCursor !== undefined ? { resumeCursor } : {}),
            })
            .pipe(
              Effect.ensuring(
                Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
              ),
            );
        };
        /** Sends one scripted step and returns the tool result the model got back. */
        const probe = (threadId: ThreadId, step: string) =>
          Effect.gen(function* () {
            const first = model.requests.length;
            yield* adapter.sendTurn({
              threadId,
              input: `PROBE ${step}`,
              attachments: [],
              modelSelection,
            });
            while (true) {
              const event = yield* Queue.take(events);
              if (event.threadId === threadId && event.type === "turn.completed") break;
            }
            const answered: FakeModelRequest | undefined = model.requests
              .slice(first)
              .find((request) => request.messages.at(-1)?.role === "tool");
            return {
              result: textOf(answered?.messages.at(-1)),
              requests: model.requests.slice(first),
            };
          }).pipe(Effect.timeout("90 seconds"));

        // Read-only run.
        const readSession = yield* startRun("read", {
          systemPrompt: "Probe run.",
          capabilities: ["read"],
        });
        const readRepo = yield* probe(readSession.threadId, "readRepo");
        NodeAssert.match(readRepo.result, /A_TS_CONTENT/);
        const offeredTools =
          readRepo.requests.find((request) => request.toolNames.length > 0)?.toolNames ?? [];
        yield* Effect.logInfo(`tools offered to a read run: ${offeredTools.join(", ")}`);
        for (const denied of [
          "bash",
          "webfetch",
          "websearch",
          "codesearch",
          "task",
          "edit",
          "write",
        ]) {
          NodeAssert.equal(offeredTools.includes(denied), false, `${denied} offered to a read run`);
        }
        NodeAssert.ok(offeredTools.includes("iskra_probe_tool"), "iskra tools missing");
        NodeAssert.equal(
          offeredTools.some((tool) => tool.includes("decoy")),
          false,
        );

        const readHoldout = yield* probe(readSession.threadId, "readHoldout");
        NodeAssert.doesNotMatch(readHoldout.result, /HOLDOUT_SECRET/);
        yield* probe(readSession.threadId, "writeRepo");
        NodeAssert.equal(NodeFS.existsSync(NodePath.join(repo, "x.txt")), false);
        yield* probe(readSession.threadId, "bash");
        NodeAssert.equal(NodeFS.existsSync(bashMarker), false);
        yield* probe(readSession.threadId, "webfetch");
        NodeAssert.equal(canary.requestCount(), 0);
        yield* probe(readSession.threadId, "task");
        NodeAssert.equal(NodeFS.existsSync(taskMarker), false);
        const iskraCall = yield* probe(readSession.threadId, "iskra");
        NodeAssert.match(iskraCall.result, /PROBE_TOOL_OK/);
        NodeAssert.deepEqual(iskra.toolCalls, ["probe_tool"]);
        NodeAssert.ok(iskra.authorizationHeaders.includes("Bearer probe-token"));

        // Read/write run.
        const writeSession = yield* startRun("write", {
          systemPrompt: "Probe run.",
          capabilities: ["read", "write"],
        });
        yield* probe(writeSession.threadId, "writeRepo");
        NodeAssert.equal(
          NodeFS.readFileSync(NodePath.join(repo, "x.txt"), "utf8"),
          "written by run",
        );
        yield* probe(writeSession.threadId, "writeOutside");
        NodeAssert.equal(NodeFS.existsSync(outside), false);

        for (const [name, decoy] of Object.entries(decoys)) {
          NodeAssert.equal(decoy.requestCount(), 0, `decoy ${name} was contacted`);
        }
        NodeAssert.equal(
          seen.some((event) => event.type === "request.opened"),
          false,
          "a run asked for approval",
        );

        // A run never resumes: the old session id is not adopted.
        const resumed = yield* startRun(
          "resume",
          { systemPrompt: "Probe run.", capabilities: ["read"] },
          readSession.resumeCursor,
        );
        NodeAssert.notDeepEqual(resumed.resumeCursor, readSession.resumeCursor);

        // A configured external server is refused before anything starts.
        const external = yield* makeOpenCodeAdapter(externalSettings, {
          environment: userEnvironment,
        });
        const refused = yield* external
          .startSession({
            threadId: ThreadId.make("probe-external"),
            cwd: repo,
            runtimeMode: "full-access",
            run: { systemPrompt: "Probe run.", capabilities: ["read"] },
          })
          .pipe(Effect.flip);
        NodeAssert.equal(
          "issue" in refused ? refused.issue : undefined,
          "Agent runs on 'opencode' can't use an external OpenCode server; choose a provider that can.",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            OpenCodeRuntimeLive,
            ServerConfig.layerTest(process.cwd(), { prefix: "iskra-oc-probe-home-" }),
            ServerSettingsService.layerTest({}),
          ).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      ),
    300_000,
  );
});

const codexBinary = binaryOnPath("codex");

describe.skipIf(codexBinary === undefined)("Codex run enforcement (real binary)", () => {
  // ponytail: only the model-free sandbox checks; the scripted app-server run (D2 steps 4-5)
  // is written on the machine that first has the binary, together with the finding.
  it("blocks network and writes outside the workspace in Codex's sandbox", () => {
    const binaryPath = codexBinary ?? "codex";
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "iskra-codex-probe-"));
    try {
      const sandbox = NodeOS.platform() === "darwin" ? "macos" : "linux";
      const run = (script: string) =>
        NodeChildProcess.spawnSync(
          binaryPath,
          ["sandbox", sandbox, "--full-auto", "--", "sh", "-c", script],
          {
            cwd: root,
            encoding: "utf8",
          },
        );
      NodeAssert.notEqual(run("curl -sS -m5 https://example.com").status, 0);
      const outside = NodePath.join(NodeOS.tmpdir(), `iskra-codex-outside-${process.pid}`);
      NodeAssert.notEqual(run(`touch ${outside}`).status, 0);
      NodeAssert.equal(NodeFS.existsSync(outside), false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
