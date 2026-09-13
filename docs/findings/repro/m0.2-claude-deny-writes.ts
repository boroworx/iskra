// M0.2 repro — Claude: can a session be made categorically read-only by the harness?
//
// Run (from repo root after `vp i`, with `claude` logged in):
//   node docs/findings/repro/m0.2-claude-deny-writes.ts <scenario>
// Scenarios: t3-approval-required | dontask | canusetool | settings-shadow | sandboxed-bash
// Env: CLAUDE_BIN (default: claude), ISKRA_SDK_PATH (default: resolve from apps/server).
//
// Each scenario starts an Agent SDK session in a throwaway temp dir, asks the agent to write a
// file (Write tool, then Bash), and prints every permission callback, every SDK
// `permission_denied` message, failed tool results, `result.permission_denials`, and whether
// the file exists afterwards.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const scenario = process.argv[2] ?? "dontask";
const sdkPath =
  process.env.ISKRA_SDK_PATH ??
  createRequire(join(import.meta.dirname, "../../../apps/server/package.json")).resolve(
    "@anthropic-ai/claude-agent-sdk",
  );
const { query } = await import(pathToFileURL(sdkPath).href);

const cwd = mkdtempSync(join(tmpdir(), "iskra-m02-claude-"));
const target = join(cwd, "probe.txt");
const READ_TOOLS = ["Read", "Glob", "Grep"];

// Harness-side deny-by-default: anything outside the read set is refused without asking anyone.
const denyByDefault = async (toolName: string, input: Record<string, unknown>) => {
  const allowed = READ_TOOLS.includes(toolName);
  console.log(`canUseTool: ${toolName} ${JSON.stringify(input)} -> ${allowed ? "allow" : "DENY"}`);
  return allowed
    ? { behavior: "allow" as const, updatedInput: input }
    : { behavior: "deny" as const, message: "Iskra: this run is read-only." };
};

const base = {
  cwd,
  model: "haiku",
  pathToClaudeCodeExecutable: process.env.CLAUDE_BIN ?? "claude",
  maxTurns: 6,
};
const scenarios: Record<string, object> = {
  // What T3 does today for runtimeMode "approval-required": user/project/local settings loaded,
  // no permissionMode passed, canUseTool as the gate (here auto-denying instead of prompting).
  "t3-approval-required": {
    ...base,
    settingSources: ["user", "project", "local"],
    canUseTool: denyByDefault,
  },
  // Filesystem settings isolated; dontAsk denies anything not pre-approved by allowedTools.
  dontask: {
    ...base,
    settingSources: [],
    permissionMode: "dontAsk",
    allowedTools: READ_TOOLS,
    canUseTool: denyByDefault,
  },
  // Filesystem settings isolated; explicit default mode; canUseTool is the only gate.
  canusetool: {
    ...base,
    settingSources: [],
    permissionMode: "default",
    canUseTool: denyByDefault,
  },
  // A project settings file allow rule plus a loaded settings source: does it shadow canUseTool?
  "settings-shadow": {
    ...base,
    settingSources: ["project"],
    canUseTool: denyByDefault,
  },
  // Bash allowed but OS-sandboxed with the cwd write-denied: is Bash granular via the sandbox?
  "sandboxed-bash": {
    ...base,
    settingSources: [],
    permissionMode: "default",
    tools: [...READ_TOOLS, "Bash"],
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: { denyWrite: [cwd] },
    },
    canUseTool: async (toolName: string, input: Record<string, unknown>) =>
      toolName === "Bash"
        ? (console.log(`canUseTool: Bash ${JSON.stringify(input)} -> allow (sandboxed)`),
          { behavior: "allow" as const, updatedInput: input })
        : denyByDefault(toolName, input),
  },
};
const options = scenarios[scenario];
if (!options) throw new Error(`unknown scenario ${scenario}`);
if (scenario === "settings-shadow") {
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(
    join(cwd, ".claude/settings.json"),
    JSON.stringify({ permissions: { allow: ["Write"] } }),
  );
}

const prompt =
  scenario === "sandboxed-bash"
    ? `Run exactly this with the Bash tool: echo hi > ${target}. Then report the result in one line and stop.`
    : `Create the file ${target} containing "hi" using the Write tool. If that is refused, try once with Bash: echo hi > ${target}. Report in one line and stop.`;

console.log(`scenario=${scenario} cwd=${cwd}`);
for await (const message of query({ prompt, options })) {
  if (message.type === "system" && message.subtype === "init") {
    console.log(`init: permissionMode=${message.permissionMode} tools=${message.tools.join(",")}`);
  } else if (message.type === "system" && message.subtype === "permission_denied") {
    console.log(
      `SDK permission_denied: ${message.tool_name} reason=${message.decision_reason_type}:${message.decision_reason ?? ""}`,
    );
  } else if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use")
        console.log(`tool_use: ${block.name} ${JSON.stringify(block.input)}`);
      if (block.type === "text") console.log(`assistant: ${block.text}`);
    }
  } else if (message.type === "user" && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type === "tool_result") {
        const text =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        console.log(`tool_result${block.is_error ? " (ERROR)" : ""}: ${text.slice(0, 200)}`);
      }
    }
  } else if (message.type === "result") {
    console.log(
      `result: ${message.subtype} permission_denials=${JSON.stringify(message.permission_denials)}`,
    );
  }
}
console.log(`\nFILE EXISTS AFTER TURN: ${existsSync(target)}  (${target})`);
