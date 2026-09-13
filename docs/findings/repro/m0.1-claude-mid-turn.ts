// M0.1 repro, Claude: what happens to a user message sent while a turn is running.
//
// Drives the `claude` CLI over stream-json, the wire @anthropic-ai/claude-agent-sdk speaks.
// T3's ClaudeAdapter feeds its promptQueue into query({ prompt: AsyncIterable }), and a
// sendTurn during a running turn is just another Queue.offer onto that iterable, i.e. exactly
// the extra stdin line this script writes.
//
// Run (needs `claude` logged in; two cheap haiku turns at most):
//   node docs/findings/repro/m0.1-claude-mid-turn.ts tool   # mid-turn message while a Bash tool runs
//   node docs/findings/repro/m0.1-claude-mid-turn.ts text   # tools disabled; mid-turn message on the first streamed text delta
// Optional: MODEL=sonnet
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.argv[2] === "text" ? "text" : "tool";
const t0 = Date.now();
const log = (tag: string, detail = "") =>
  console.log(`${String(Date.now() - t0).padStart(6)}ms  ${tag}${detail ? `  ${detail}` : ""}`);
const clip = (s: string) => JSON.stringify(s.length > 90 ? `${s.slice(0, 90)}…` : s);

const child = spawn(
  "claude",
  [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages", // echoes each stdin user message when the CLI actually consumes it
    "--model",
    process.env.MODEL ?? "haiku",
    ...(scenario === "tool"
      ? ["--allowedTools", "Bash(sleep:*)"]
      : ["--tools", "", "--include-partial-messages"]),
    "--strict-mcp-config",
    "--setting-sources",
    "project",
  ],
  { cwd: mkdtempSync(join(tmpdir(), "iskra-m01-")), stdio: ["pipe", "pipe", "inherit"] },
);

const send = (label: string, text: string) => {
  log(`>> stdin ${label}`, clip(text));
  child.stdin.write(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: "",
    })}\n`,
  );
};

const first =
  scenario === "tool"
    ? "Use the Bash tool to run exactly `sleep 20`. After it finishes, reply with the single word DONE."
    : "Write the integers from 1 to 400 separated by single spaces. Nothing else.";
const steer = "Also include the word BANANA in your very next message.";

let steered = false;
let results = 0;
let bananaSeenAt: number | null = null;
let firstResultAt: number | null = null;
let steerSentAt = 0;
let toolResultAt: number | null = null;
const steerNow = () => {
  if (steered) return;
  steered = true;
  steerSentAt = Date.now() - t0;
  send("MID-TURN", steer);
};

createInterface({ input: child.stdout }).on("line", (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "system") {
    if (msg.subtype === "init") log("system init", `model=${msg.model}`);
    return;
  }
  if (msg.type === "stream_event") {
    if (
      msg.event?.type === "content_block_delta" &&
      msg.event.delta?.type === "text_delta" &&
      !steered
    ) {
      log("first text delta", clip(msg.event.delta.text));
      steerNow();
    }
    return;
  }
  if (msg.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "tool_use") {
        log("assistant tool_use", `${block.name} ${clip(JSON.stringify(block.input))}`);
        if (scenario === "tool") setTimeout(steerNow, 3000); // well inside the 20s sleep
      } else if (block.type === "text") {
        log("assistant text", clip(block.text));
        if (/BANANA/.test(block.text) && bananaSeenAt === null) bananaSeenAt = Date.now() - t0;
      }
    }
    return;
  }
  if (msg.type === "user") {
    const content = msg.message?.content;
    const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content) }];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        toolResultAt ??= Date.now() - t0;
        log("user tool_result");
      } else if (block.type === "text") {
        log(`user message consumed${msg.isReplay ? " (replay)" : ""}`, clip(block.text));
      }
    }
    return;
  }
  if (msg.type === "result") {
    results += 1;
    firstResultAt ??= Date.now() - t0;
    log(
      `RESULT #${results}`,
      `subtype=${msg.subtype} num_turns=${msg.num_turns} ${clip(String(msg.result ?? ""))}`,
    );
    if (bananaSeenAt !== null || results >= 2) finish();
  }
});

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  log("---");
  log("steer sent at", `${steerSentAt}ms`);
  log("tool_result at", toolResultAt === null ? "n/a" : `${toolResultAt}ms`);
  log("BANANA first seen at", bananaSeenAt === null ? "never" : `${bananaSeenAt}ms`);
  log("first RESULT at", firstResultAt === null ? "never" : `${firstResultAt}ms`);
  log("results emitted", String(results));
  child.stdin.end();
}
const timeout = setTimeout(() => {
  log("TIMEOUT");
  finish();
}, 150_000);

send("TURN-1", first);
