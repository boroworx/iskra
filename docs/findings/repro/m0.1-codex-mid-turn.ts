// M0.1 repro, Codex: what happens to a user message sent while a turn is running.
//
// Speaks the `codex app-server` JSON-lines protocol directly (no "jsonrpc" field, same framing
// as packages/effect-codex-app-server). Two modes:
//   start: a second `turn/start` mid-turn, which is what T3's CodexSessionRuntime.sendTurn does today
//   steer: `turn/steer` with expectedTurnId, the app-server's native mid-turn input that T3 does not call
//
// Run (needs `codex` on PATH and logged in):
//   node docs/findings/repro/m0.1-codex-mid-turn.ts start
//   node docs/findings/repro/m0.1-codex-mid-turn.ts steer
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2] === "steer" ? "steer" : "start";
const t0 = Date.now();
const log = (tag: string, detail = "") =>
  console.log(`${String(Date.now() - t0).padStart(6)}ms  ${tag}${detail ? `  ${detail}` : ""}`);
const clip = (s: string) => JSON.stringify(s.length > 90 ? `${s.slice(0, 90)}…` : s);

const cwd = mkdtempSync(join(tmpdir(), "iskra-m01-codex-"));
const child = spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "inherit"] });

let nextId = 1;
const pending = new Map<number, (result: any) => void>();
const request = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
const text = (value: string) => [{ type: "text", text: value }];

let activeTurnId: string | null = null;
let threadId = "";
let steered = false;
let agentText = "";
const completed: Array<string> = [];

createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) {
    if (msg.error) log("RPC error", clip(JSON.stringify(msg.error)));
    pending.get(msg.id)!(msg.result ?? msg.error);
    pending.delete(msg.id);
    return;
  }
  if (msg.id !== undefined && msg.method) {
    // Server → client request (approvals). Not expected with approvalPolicy "never"; decline if one arrives.
    log("server request", msg.method);
    child.stdin.write(`${JSON.stringify({ id: msg.id, result: { decision: "decline" } })}\n`);
    return;
  }
  const p = msg.params ?? {};
  switch (msg.method) {
    case "turn/started":
      log("turn/started", p.turn?.id);
      activeTurnId ??= p.turn?.id;
      break;
    case "turn/completed":
      log("turn/completed", `${p.turn?.id} status=${p.turn?.status}`);
      completed.push(p.turn?.id);
      if (completed.length >= (mode === "start" ? 2 : 1)) finish();
      break;
    case "item/started":
      log(
        "item/started",
        `${p.item?.type}${p.item?.command ? ` ${clip(String(p.item.command))}` : ""}`,
      );
      if (p.item?.type === "commandExecution" && !steered) setTimeout(steerNow, 3000);
      break;
    case "item/completed":
      if (p.item?.type === "agentMessage") log("agentMessage", clip(String(p.item.text ?? "")));
      if (p.item?.type === "userMessage")
        log("userMessage recorded", clip(JSON.stringify(p.item.content)));
      break;
    case "item/agentMessage/delta":
      agentText += p.delta ?? "";
      break;
  }
});

async function steerNow() {
  if (steered || !activeTurnId) return;
  steered = true;
  const body = "Also include the word BANANA in your very next message.";
  log(`>> MID-TURN ${mode}`, clip(body));
  const response =
    mode === "steer"
      ? await request("turn/steer", { threadId, expectedTurnId: activeTurnId, input: text(body) })
      : await request("turn/start", { threadId, input: text(body) });
  log(`<< ${mode} response`, clip(JSON.stringify(response)));
}

function finish() {
  log("---");
  log("BANANA in agent text", String(/BANANA/.test(agentText)));
  log("turns completed", completed.join(", "));
  child.stdin.end();
  child.kill(); // PID captured at spawn
}
setTimeout(() => {
  log("TIMEOUT");
  finish();
}, 150_000);

await request("initialize", { clientInfo: { name: "iskra-m0.1", version: "0" } });
child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
const thread = await request("thread/start", {
  cwd,
  approvalPolicy: "never",
  sandbox: "read-only",
});
threadId = thread.thread.id;
log("thread", threadId);
await request("turn/start", {
  threadId,
  input: text(
    "Run exactly `sleep 20` in the shell. After it finishes, reply with the single word DONE.",
  ),
});
