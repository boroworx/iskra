// M0.2 repro — Codex: can a session be made categorically read-only by the harness?
//
// Run (from repo root, needs `codex` on PATH and `codex login` done):
//   node docs/findings/repro/m0.2-codex-deny-writes.ts
//
// Starts `codex app-server`, opens a thread with sandbox "read-only" and approvalPolicy
// "never" (no escalation path, nothing for a human to approve), asks the agent to create a
// file in a throwaway temp dir, and prints every command/file-change item plus any server
// request (auto-declined) and whether the file exists afterwards. Dependency-free on purpose.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const cwd = mkdtempSync(join(tmpdir(), "iskra-m02-codex-"));
const target = join(cwd, "probe.txt");
const codex = spawn(process.env.CODEX_BIN ?? "codex", ["app-server"], {
  cwd,
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map<number, (result: unknown) => void>();
const send = (message: object) => codex.stdin.write(`${JSON.stringify(message)}\n`);
const request = <T>(method: string, params: unknown) =>
  new Promise<T>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve as (result: unknown) => void);
    send({ id, method, params });
  });

let finish: () => void;
const turnDone = new Promise<void>((resolve) => (finish = resolve));

createInterface({ input: codex.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method === undefined) {
    if (message.error) console.log("RPC ERROR", JSON.stringify(message.error));
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.id !== undefined) {
    // Server request (approval). Harness-side deny: decline without asking anyone.
    console.log("SERVER REQUEST (declined):", message.method, JSON.stringify(message.params));
    send({ id: message.id, result: { decision: "decline" } });
    return;
  }
  const item = message.params?.item;
  if (
    message.method === "item/completed" &&
    item &&
    item.type !== "agentMessage" &&
    item.type !== "reasoning" &&
    item.type !== "userMessage"
  ) {
    console.log("ITEM COMPLETED:", JSON.stringify(item));
  }
  if (message.method === "item/completed" && item?.type === "agentMessage") {
    console.log("AGENT:", item.text);
  }
  if (message.method === "turn/completed") finish();
});

await request("initialize", {
  clientInfo: { name: "iskra_m02_repro", title: "Iskra M0.2 repro", version: "0.0.0" },
  capabilities: { experimentalApi: true },
});
send({ method: "initialized" });

const { thread } = await request<{ thread: { id: string } }>("thread/start", {
  cwd,
  sandbox: "read-only",
  approvalPolicy: "never",
});
await request("turn/start", {
  threadId: thread.id,
  input: [
    {
      type: "text",
      text: `Create the file ${target} containing the word hi. Try apply_patch first, then a shell command if that fails. Report briefly and stop.`,
    },
  ],
  sandboxPolicy: { type: "readOnly" },
  approvalPolicy: "never",
});

await turnDone;
console.log(`\nFILE EXISTS AFTER TURN: ${existsSync(target)}  (${target})`);
codex.kill();
