# M2 — What OpenCode enforces for an agent run

Question: can OpenCode host an Iskra run (verifier, helper, critic) without widening it, and
which of a run's limits hold? M2 hosts read and read/write runs on OpenCode only if they do.

Runs: OpenCode 1.18.27, macOS. The gated test
`apps/server/integration/providerRunEnforcement.integration.test.ts` starts runs through the
real `OpenCodeAdapter` run path against a local fake OpenAI-compatible model and fake MCP
servers. `@ai-sdk/openai-compatible` is bundled in the binary, so no package install, network or
credentials were needed. A standalone config probe (decoy MCP entries read back from `/config`
and `/mcp`) and single-turn probes against `opencode serve` preceded it.

## Verdict

| Limit                                               | Enforced by                                                                       | Surfaces as                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Shell, web and subagent tools                       | `deny` for `bash`, `webfetch`, `websearch`, `codesearch`, `task`, and `*`         | the tool is not offered; a call fails as an unavailable tool     |
| Edits in a read-only run                            | `edit: deny` (covers `edit` and `write`)                                          | not offered                                                      |
| File reads and writes outside the worktree          | `external_directory: deny`                                                        | tool error "The user has specified a rule which prevents you..." |
| Writes inside the worktree                          | `edit: allow` only with `write`                                                   | normal tool result                                               |
| Iskra MCP tools                                     | `iskra_*: allow` (an MCP tool's permission is `<server>_<tool>`)                  | normal tool result                                               |
| User, home, project and env-file MCP servers        | run HOME and XDG_CONFIG_HOME, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, rebuilt config | never load; decoy servers received 0 requests                    |
| Asks that skip session rules (doom loop, subagents) | the adapter replies `reject`                                                      | `tool.denied`, never an approval                                 |
| Resume                                              | the adapter ignores a run's resume cursor                                         | a new session                                                    |
| External server (Server URL set)                    | refused before start                                                              | "can't use an external OpenCode server"                          |

## What the runs showed

1. **Project config can be disabled.** `OPENCODE_DISABLE_PROJECT_CONFIG=1` stopped both
   `<repo>/opencode.json` (with `permission: {"*": "allow"}`) and `<repo>/.opencode/opencode.json`.
   Without the flag both loaded, and the project's `"*": "allow"` became the agent default.
2. **`~/.opencode/opencode.json` loads even with the flag.** A run therefore gets its own HOME and
   XDG_CONFIG_HOME. XDG_DATA_HOME, XDG_CACHE_HOME and XDG_STATE_HOME are passed explicitly, so
   auth.json and the provider cache still resolve.
3. **`OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` load more config files**, MCP servers included.
   The run environment keeps named OpenCode variables only, not every `OPENCODE_*`.
4. **Denied tools are not offered.** A read run's model saw `glob, grep, read, iskra_probe_tool`; a
   read/write run added `edit, write`. Calling `bash`, `webfetch`, `task` or `write` anyway failed
   with "Model tried to call unavailable tool", and nothing ran (marker files absent, canary
   server untouched).
5. **Paths outside the resolved worktree are external.** A read of the fake Iskra home's
   `holdouts/p.json` and a write to a sibling file were denied. OpenCode resolves the session
   directory, so on macOS `/var/...` paths to a `/private/var/...` worktree also counted as
   external: a worktree reached through a symlink sees its own files denied (fails closed).
6. **No `permission.asked` reached the adapter** in any probe; every denial was a tool error the
   model saw. The auto-reject covers the paths that bypass session rules.
7. **Iskra's MCP server works under deny-by-default** with the `iskra_*` rule, carrying the
   session's bearer header.
8. **A second run given the first run's resume cursor** started a different OpenCode session.

## Limits

- No OS sandbox, so shell and network can't be confined: OpenCode runs never get `shell` or
  `network`, and builders with a shell stay on Claude.
- Runs share the user's OpenCode data directory (session database, auth).
- Only the inherited `OPENCODE_CONFIG_CONTENT` `provider` block reaches a run. Providers set up
  only in the user's opencode.json are unavailable; signed-in providers (auth.json) and
  `<PROVIDER>_API_KEY` variables work.
- Formatters and LSP servers run project binaries, so the run config disables both.

## Consequences (implemented)

- `runEnforcement.ts`: `opencode: {capabilities: ["read", "write"], egressAllowlist: false}`;
  `runRefusal(provider, run, {external})`.
- `OpenCodeAdapter.ts` run path: per-run environment and server, `buildOpenCodeRunPermissionRules`
  for the session and `openCodeRunConfigContent` for agent defaults, asks rejected as
  `tool.denied`, no resume, external server refused, the run's system prompt.
- `ProviderService.ts` passes `external` for OpenCode instances with a Server URL.
