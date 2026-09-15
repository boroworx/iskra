# M2 — Codex run enforcement (not verified; runs refused)

Status: Codex runs are refused. `RUN_ENFORCEMENT.codex.capabilities` is `[]`, so
`ProviderService` answers every run with "Agent runs on 'codex' can't enforce its restrictions;
choose a provider that can." The machine that built M2 has no Codex binary, so nothing below has
been observed on a real binary.

## What the run path does

Built in `CodexAdapter.ts` and `CodexSessionRuntime.ts`, used only once the table allows it:

- Threads start with `approvalPolicy: "never"` and sandbox `read-only`, or `workspace-write` when the
  run may write. Turns send `sandboxPolicy` `readOnly` or `workspaceWrite` with
  `writableRoots: [cwd]`, both with `networkAccess: false`.
- A run needing `network`, or a project egress allowlist, is refused in the adapter: Codex's
  network switch is all-or-nothing.
- `CODEX_HOME` is a temp directory holding a copy of the account's `auth.json` and an empty
  `config.toml`, so the user's `mcp_servers`, profiles and sessions don't load. Iskra's MCP server
  is still added with `-c mcp_servers.iskra...`.
- The environment is the run allowlist plus `OPENAI_API_KEY`/`CODEX_API_KEY`; launch args are
  ignored; `thread/resume` is never sent.

## To enable

1. On a machine with `codex`, run
   `vp test run apps/server/integration/providerRunEnforcement.integration.test.ts`. Its Codex
   block runs the model-free sandbox checks (network and outside writes blocked).
2. Add the scripted app-server run (plan M2-D2, Codex steps 4-5): a run through the adapter against
   `integration/fixtures/fakeModelServer.ts`'s Responses stream, asserting curl fails, writes
   outside the worktree fail, a commit in the worktree succeeds, `iskra_probe_tool` works, decoy MCP
   servers see 0 requests, and a resume cursor sends no `thread/resume`.
3. Record the version and results here, then enable Codex runs in their own commit:
   `codex: {capabilities: ["read", "write", "shell"]}`.

## Expected limits

- The sandbox allows reads anywhere, so a Codex shell could read the Iskra home: holdouts would not
  be confidential from a Codex run.
- No egress allowlist.
- Heavy commands would be prompt-only; the throttled resource environment Claude runs get is not
  wired for Codex yet.
- The Responses stream in the fake model is unverified against Codex.
