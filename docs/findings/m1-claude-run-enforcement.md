# M1 — What Claude enforces for an agent run

Question: which of a run's limits (files, shell network, egress, heavy commands, MCP) does the
Claude CLI enforce by itself, and how does each denial surface? M1 relies on the answers for
capability ceilings, the project egress policy and hard MCP isolation.

Runs: Claude Code 2.1.270, Agent SDK 0.3.260, macOS, Haiku, `permissionMode: "dontAsk"`,
`settingSources: []`, a throwaway worktree dir with a sibling "Iskra home" holding a secret.
The probe was a one-off script modelled on `docs/findings/repro/m0.2-claude-deny-writes.ts`.

## Verdict

| Limit                            | Enforced by                                                                     | Surfaces as                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| File reads outside the worktree  | `Read(//<cwd>/**)`, `Glob(//<cwd>/**)`, `Grep(//<cwd>/**)` allow rules          | SDK `permission_denied` → `tool.denied`                                                  |
| File writes outside the worktree | `Edit(//<cwd>/**)`, `Write(//<cwd>/**)`, `NotebookEdit(//<cwd>/**)` allow rules | SDK `permission_denied` → `tool.denied`                                                  |
| Shell network                    | `sandbox.network.allowedDomains` + `strictAllowlist: true`                      | failed tool result with a `<sandbox_violations>` block → `tool.denied` (adapter-derived) |
| Shell reads of the Iskra home    | `sandbox.filesystem.denyRead` (+ `allowRead` for the worktree)                  | failed tool result, `Operation not permitted` only                                       |
| WebFetch egress                  | `WebFetch(domain:<allowed>)` allow rules                                        | SDK `permission_denied` → `tool.denied`                                                  |
| Heavy commands                   | exact `Bash(<command>)` deny rules + a PreToolUse hook                          | rule: `permission_denied`; hook: none, so the adapter emits `tool.denied`                |
| Non-Iskra MCP servers            | `strictMcpConfig: true`                                                         | the tools never load                                                                     |

## What the runs showed

1. **Bare file tools reach every path.** With `allowedTools: ["Read", "Glob", "Grep"]` the agent
   read a file outside the worktree, and Glob listed the Iskra home's `secret.txt`. No denial.
   A bare entry pre-approves the tool for any path; the M0.2 read-only shape was not confined.
2. **Path-scoped rules confine them.** `Read(//<cwd>/**)` allowed the worktree file and denied
   the outside one with `permission_denied` (reason `mode`). Glob and Grep need their own scoped
   rules: with only the Read rule they were not offered at all; with `Glob(//<cwd>/**)` and
   `Grep(//<cwd>/**)` they worked inside and were denied outside. `Edit(...)`/`Write(...)` rules
   behave the same way.
3. **Read-only shell commands inside the cwd run without Bash being allowed.** With only a Read
   rule, `grep -r` in the worktree ran; `cat` of an outside file was denied. Claude Code
   auto-approves read-only commands in its working directory even in `dontAsk`.
4. **The sandbox holds.** `curl https://example.com` failed with a 403 from the sandbox proxy and a
   `deny network-outbound example.com:443 (host is not on the allow list)` violation when no
   domain was allowed, and returned 200 once `example.com` was allowed. `cat` of the Iskra-home
   secret failed with `Operation not permitted`. Writes inside the worktree succeeded.
   Neither kind of block emits `permission_denied`; only network blocks leave a
   `<sandbox_violations>` block in the output.
5. **The sandbox refused writes to a worktree under `~/.claude`.** The same write succeeded under
   `~/Library/Caches`. Expect a read-only shell for card worktrees below `~/.claude` (for
   example a dev server's `.iskra-dev` inside `~/.claude/...`); whether other `.claude` paths
   are protected wasn't checked.
6. **A PreToolUse hook deny emits no `permission_denied`.** The command was blocked, the model saw
   the hook's reason as the tool error, and `result.permission_denials` listed it. An exact
   `Bash(pnpm build)` deny rule did emit `permission_denied` (reason `rule`).
7. **`strictMcpConfig` removes claude.ai connectors.** `settingSources: []` alone still loaded 171
   `mcp__claude_ai_*` tools from 12 account connectors (Gmail, Drive, Railway, Cloudflare...).
   With `strictMcpConfig: true` the session had 0 MCP tools and no MCP servers.
8. **`WebFetch(domain:example.com)`** fetched example.com and denied example.org.

## Consequences for Iskra (implemented in `ClaudeAdapter.ts`)

- File tools are always scoped to the run's cwd; a run without a cwd gets no file tools.
- `shell` (only with `write`) turns the sandbox on with `failIfUnavailable: true` and
  `allowUnsandboxedCommands: false`. Egress `none` allows no domains; `allowlist` allows exactly
  the project's list, and a domain both allowed and denied refuses the run.
- WebSearch is never granted to a run: it can't be scoped to domains.
- The adapter emits `tool.denied` for hook denials and for `<sandbox_violations>` output.
- Runs pass `strictMcpConfig: true` with only the `iskra` server, and `disallowedTools` includes
  `mcp__claude_ai_*`.

## Git from the sandboxed shell

Probe (M1 integration): Claude Code 2.1.271, the run's exact sandbox shape (`denyRead` Iskra home,
`allowRead` the worktree, no `allowWrite`), a repository with a linked worktree
(`git worktree add -b iskra/probe`) under `~/Library/Caches`. Commands ran through Bash.

| Command from the worktree                        | Result  | Evidence                                             |
| ------------------------------------------------ | ------- | ---------------------------------------------------- |
| `git status`, `git diff --stat`                  | allowed | `inside.txt \| 1 +`                                  |
| `git add -A`, `git commit`, `git commit -am`     | allowed | `git log` outside the sandbox shows the new commit   |
| `git branch -f side HEAD`, `git branch iskra/x`  | allowed | the other branches moved/appeared in the main repo   |
| `git update-ref refs/heads/main HEAD`            | allowed | the main checkout's `main` now points at the commit  |
| write `.git/info/exclude`, `git -C <main> gc`    | allowed | no error                                             |
| write `.git/hooks/pre-commit`                    | blocked | `operation not permitted`                            |
| append to `.git/config`                          | blocked | `operation not permitted`                            |
| write a file in the main checkout's working tree | blocked | `operation not permitted`                            |
| write a file next to the repository              | blocked | `operation not permitted`                            |
| read the Iskra home                              | blocked | `Operation not permitted`                            |

Adding `allowWrite` for the worktree's git dir, `objects` and the branch's ref directories changed
nothing: Claude Code already lets a worktree's shell write the repository's common `.git`, except
`hooks/` and `config`. So Iskra adds no git paths to the sandbox; builders can commit themselves,
and the server still commits leftovers before review.

Residual risk: a builder's shell can write anything in the shared `.git` but hooks and config. It
can move or create any ref (including the branch checked out in the person's main checkout, via
`update-ref`), write objects, edit `info/exclude` and run `gc`. It can't run code through hooks or
config, and can't touch the main checkout's files. Review evidence is pinned to the card's head commit, but
a ref moved elsewhere is not detected. Worktrees under `~/.claude`
still get a read-only shell (finding 5).

## Not verified

- Failure when the sandbox can't start. `failIfUnavailable` is documented to exit at startup; the
  adapter then reports a session error. It was not forced here.
- Linux (bubblewrap/seccomp) and Windows. Rule paths use the POSIX `//` form.
- Whether `disallowedTools: ["mcp__claude_ai_*"]` matches by prefix on its own; `strictMcpConfig`
  already removed the tools.
- Filesystem sandbox denials still surface only as failed tool results.
