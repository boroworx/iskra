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
config, and can't touch the main checkout's files. Review evidence is pinned to the card's head
commit. Worktrees under `~/.claude` still get a read-only shell (finding 5).

Ref guard (`apps/server/src/orchestration/CardRefGuard.ts`): Iskra installs no hooks in the user's
repository. Instead, each card run's turn snapshots `refs/heads` and `refs/tags` in the
repository's common dir when the turn is requested, and compares when it settles or the session
ends. A ref other than a card branch that was created, moved or deleted is reported, not put back:
the card gets an `error` activity (`refMovedOutsideCard`) with each ref's old and new ids
(`refChanges`) and a `refsChanged` question, and it is paused. A person answers with
`card.refs.restore` (all refs, or the named ones, each put back with a compare-and-swap
`update-ref`; a ref that changed again since the report is skipped and said so) or `card.refs.keep`,
then resumes the card. Restoring was automatic at first, but a person committing in their own
checkout during a card's turn is indistinguishable from the agent, and reverting that left their
committed work showing as uncommitted. This detects after the turn; it does not prevent the write,
and objects, `info/exclude` and `gc` are not covered.

- Iskra's own branch writes (creating and deleting a card branch, landing's fast-forward of the
  base, a person's restore) run under the same per-repository lock and move open turns' baselines.
- Pushes only touch `refs/remotes`, and checkpoints live under `refs/iskra`, so neither is compared.
- Card branches are excluded because their own agents and landing's rebase move them. So a card's
  agent moving another card's branch goes unnoticed.
- A person's own branch or tag changes in the same repository during a guarded turn are
  indistinguishable from the agent's, so they are reported too; the person keeps them.
- Snapshots live in memory, so a turn that spans a server restart is not checked, and a restore
  answered just before a restart may not run. The activity keeps the full ids for doing it by hand.

### Preventing ref writes in the sandbox: not applied

Probe (security follow-up): Claude Code 2.1.271, Agent SDK 0.3.260, git 2.55.0, macOS, Haiku, the
run's sandbox shape plus the rules below, a repository with `main`, `side`, tag `v0` and a linked
worktree on `iskra/probe` under `~/Library/Caches`. Each command ran as its own Bash call from the
worktree; refs were read outside the sandbox afterwards. `<c>` is the common dir.

| Rules                                                                                           | Own commit on `iskra/probe`             | `update-ref main`, `branch rogue`, `tag`, `branch -f side`, `branch iskra/other` |
| ----------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| none                                                                                            | allowed                                 | all allowed                                                                      |
| `denyWrite` `<c>/refs/heads`, `<c>/refs/tags`, `<c>/packed-refs`; `allowWrite` the branch ref, its `.lock`, its reflog | blocked: `Unable to create '<c>/refs/heads/iskra/probe.lock': Operation not permitted` | all blocked                                    |
| `denyWrite` `<c>/refs/heads/*`, `<c>/refs/tags/**`, `<c>/packed-refs`, `<c>/packed-refs.lock`   | blocked, same error                     | all blocked                                                                      |
| `denyWrite` `<c>/refs/heads/main`, `main.lock`, `<c>/packed-refs`, `packed-refs.lock`           | allowed, but prints `error: Unable to create '<c>/packed-refs.lock'` | `main` blocked; the rest allowed                     |

Why it isn't applied:

- `denyWrite` wins over `allowWrite`, so the card's own branch can't be carved out of a denied
  `refs/heads`. A `*` glob also matched the nested `refs/heads/iskra/probe.lock`.
- Blocking new branches and tags needs a deny on the `refs/heads` or `refs/tags` directory, which
  blocks the card's own commits too. Literal denies can only cover refs that already exist when
  the session starts.
- Literal denies still need `packed-refs` and its lock denied (an edit there moves a packed ref).
  With those denied, every normal `git commit` prints an error even though the commit lands, and
  `pack-refs`/`gc` fail.
- Linux: bubblewrap can't deny a path that doesn't exist yet (untested here).

The report-only guard stays the only protection.

## Not verified

- Failure when the sandbox can't start. `failIfUnavailable` is documented to exit at startup; the
  adapter then reports a session error. It was not forced here.
- Linux (bubblewrap/seccomp) and Windows. Rule paths use the POSIX `//` form.
- Whether `disallowedTools: ["mcp__claude_ai_*"]` matches by prefix on its own; `strictMcpConfig`
  already removed the tools.
- Filesystem sandbox denials still surface only as failed tool results.
