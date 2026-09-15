import type { ProjectId, PullRequestComment, PullRequestListEntry, PullRequestRef } from "@iskra/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProcessRunner } from "../processRunner.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { SourceControlRateLimit } from "../sourceControl/SourceControlRateLimit.ts";
import type { FailedRun } from "./triggerRules.ts";

/**
 * What the trigger reactor reads from outside Iskra. Every read answers empty (and logs) when the
 * host can't be asked, so a missing gh or a rate-limited host only delays a fire.
 */
export class TriggerSources extends Context.Service<
  TriggerSources,
  {
    /** origin's HEAD branch of the checkout, or null. */
    readonly defaultBranch: (cwd: string) => Effect.Effect<string | null>;
    /** The latest failed workflow runs on `branch`. */
    readonly failedRuns: (input: { readonly cwd: string; readonly branch: string }) => Effect.Effect<ReadonlyArray<FailedRun>>;
    readonly openPullRequests: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<PullRequestListEntry>>;
    /** Conversation and review-thread comments on a pull request. */
    readonly comments: (ref: PullRequestRef) => Effect.Effect<ReadonlyArray<PullRequestComment>>;
    /** The M1 collaborator rule: write, maintain or admin on the repository, cached for an hour. */
    readonly isTrusted: (input: { readonly cwd: string; readonly ref: PullRequestRef; readonly login: string }) => Effect.Effect<boolean>;
  }
>()("@iskra/cli/orchestration/triggerSources") {}

const FailedRuns = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      databaseId: Schema.Number,
      headSha: Schema.String,
      name: Schema.String,
      url: Schema.String,
      createdAt: Schema.String,
    }),
  ),
);
const decodeFailedRuns = Schema.decodeUnknownEffect(FailedRuns);

// Same rule as CardLandingReactor's comment trust (M1).
const TRUSTED_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const PERMISSION_CACHE_MS = 60 * 60 * 1000;
const RUNS_PER_POLL = 20;

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner;
  const pullRequests = yield* PullRequestService;
  const rateLimit = yield* Effect.serviceOption(SourceControlRateLimit);

  const quietly =
    <A>(what: string, fallback: A) =>
    <E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.logWarning(`trigger source could not ${what}`, { cause: Cause.pretty(cause) }).pipe(Effect.as(fallback)),
        ),
      );

  const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
    runner
      .run({ command, args, cwd, timeout: "30 seconds" })
      .pipe(Effect.map((output) => (output.code === 0 ? output.stdout.trim() : null)), Effect.orElseSucceed(() => null));

  // gh calls outside PullRequestService still stand down while the host is rate limited.
  const githubPaused = Option.isNone(rateLimit)
    ? Effect.succeed(false)
    : rateLimit.value.check({ provider: "github", host: "github.com" }).pipe(Effect.as(false), Effect.orElseSucceed(() => true));

  const defaultBranch = (cwd: string) =>
    run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd).pipe(
      Effect.map((ref) => (ref === null || ref.length === 0 ? null : ref.replace(/^origin\//, ""))),
    );

  const failedRuns = (input: { readonly cwd: string; readonly branch: string }) =>
    Effect.gen(function* () {
      if (yield* githubPaused) return [];
      const json = yield* run(
        "gh",
        ["run", "list", "--branch", input.branch, "--status", "failure", "--limit", String(RUNS_PER_POLL), "--json", "databaseId,headSha,name,url,createdAt"],
        input.cwd,
      );
      return json === null ? [] : yield* decodeFailedRuns(json);
    }).pipe(quietly<ReadonlyArray<FailedRun>>("list failed runs", []));

  const openPullRequests = (projectId: ProjectId) =>
    pullRequests.list({ state: "open", projectId }).pipe(
      Effect.map((result) => result.entries),
      quietly<ReadonlyArray<PullRequestListEntry>>("list open pull requests", []),
    );

  const comments = (ref: PullRequestRef) =>
    pullRequests.activity(ref).pipe(
      Effect.map((activity): ReadonlyArray<PullRequestComment> => [
        ...activity.comments,
        ...activity.reviewThreads.flatMap((thread) =>
          thread.comments.map((comment) => ({
            ...comment,
            kind: "review-comment" as const,
            path: thread.path,
            reviewState: null,
          })),
        ),
      ]),
      quietly<ReadonlyArray<PullRequestComment>>("read pull request comments", []),
    );

  // ponytail: asks gh with the machine's own login like CardLandingReactor; share one lookup if
  // the two caches ever disagree in practice.
  const permissions = new Map<string, { readonly trusted: boolean; readonly at: number }>();
  const isTrusted = (input: { readonly cwd: string; readonly ref: PullRequestRef; readonly login: string }) =>
    Effect.gen(function* () {
      const hostName = input.ref.host ?? "";
      const key = `${hostName}/${input.ref.repository}:${input.login}`.toLowerCase();
      const now = yield* Clock.currentTimeMillis;
      const cached = permissions.get(key);
      if (cached !== undefined && now - cached.at < PERMISSION_CACHE_MS) return cached.trusted;
      const permission = hostName.endsWith("github.com")
        ? yield* run("gh", ["api", `repos/${input.ref.repository}/collaborators/${input.login}/permission`, "--jq", ".permission"], input.cwd)
        : null;
      // A host that can't say trusts only the account Iskra itself is signed in as.
      const trusted =
        permission !== null
          ? TRUSTED_PERMISSIONS.has(permission)
          : (yield* run("gh", ["api", "user", "--jq", ".login"], input.cwd))?.toLowerCase() === input.login.toLowerCase();
      permissions.set(key, { trusted, at: now });
      return trusted;
    });

  return { defaultBranch, failedRuns, openPullRequests, comments, isTrusted } satisfies TriggerSources["Service"];
});

export const layer = Layer.effect(TriggerSources, make);
