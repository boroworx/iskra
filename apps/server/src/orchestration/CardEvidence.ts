import {
  CARD_PORT_BLOCK_SIZE,
  ProviderInstanceId,
  ThreadId,
  type CardEvidenceItem,
  type CardId,
  type CardRiskClaims,
  type CardScopeFlag,
  type EnvironmentId,
  type PreviewAutomationSnapshot,
  type ProjectScript,
  type Reason,
} from "@iskra/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { ProcessRunner } from "../processRunner.ts";

/** The reason code a builder's review request is recorded with; the review gate starts on it. */
export const REVIEW_REQUESTED_CODE = "reviewRequested";

const RISK_LINE =
  /\n\nRisks \(claimed\): side effects (low|medium|high), performance (low|medium|high), compatibility (low|medium|high)\.(?:\n([\s\S]*))?$/;

/** The text a review request is recorded with: the owner's summary and its risk claims. */
export function renderReviewRequest(summary: string, risks: CardRiskClaims): string {
  const notes = risks.notes.trim();
  return `${summary.trim()}\n\nRisks (claimed): side effects ${risks.sideEffect}, performance ${risks.performance}, compatibility ${risks.compatibility}.${notes.length > 0 ? `\n${notes}` : ""}`;
}

/** The risk claims a review request's text carries, or null for text without them. */
export function riskClaimsOf(body: string): CardRiskClaims | null {
  const match = RISK_LINE.exec(body);
  if (match === null) return null;
  const [, sideEffect, performance, compatibility, notes] = match;
  return {
    sideEffect: sideEffect as CardRiskClaims["sideEffect"],
    performance: performance as CardRiskClaims["performance"],
    compatibility: compatibility as CardRiskClaims["compatibility"],
    notes: notes ?? "",
  };
}

// ---------------------------------------------------------------------------------------------
// Scope judge

/** A file the card changes against its base, with the lines it adds. */
export interface ChangedFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly addedLines: ReadonlyArray<string>;
}

/** A dependency manifest's text before and after the card's change. */
export interface ManifestChange {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs|swift)$/;
const SKIPPED_TEST =
  /\b(it|test|describe|context|suite)\.(skip|only|todo)\s*\(|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(|@Disabled\b|@Ignore\b|#\[ignore\]|\bpytest\.mark\.skip\b|\bt\.Skip\(/;
const PROTECTED = [/^\.iskra\//, /^\.github\/workflows\//];

const versionOf = (range: string): ReadonlyArray<number> | null => {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  return match === null ? null : [match[1], match[2], match[3]].map((part) => Number(part ?? 0));
};

const isLower = (after: ReadonlyArray<number>, before: ReadonlyArray<number>) => {
  for (let index = 0; index < 3; index += 1) {
    if (after[index]! !== before[index]!) return after[index]! < before[index]!;
  }
  return false;
};

const dependenciesOf = (text: string | null): Record<string, string> => {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const merged: Record<string, string> = {};
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const section = record[field];
      if (typeof section !== "object" || section === null) continue;
      for (const [name, version] of Object.entries(section)) {
        if (typeof version === "string") merged[name] = version;
      }
    }
    return merged;
  } catch {
    return {};
  }
};

/** Outside-area flags past this many would bury the rest; the count still shows in the last one. */
const OUTSIDE_AREA_FLAG_LIMIT = 10;

/**
 * Flags what a person should see before merging, from the card's changed files alone. Deleted
 * tests, newly skipped or focused tests, dependency downgrades and protected paths are hard: the
 * merge waits for a person to acknowledge them. Files outside the estimate's likely areas are advice.
 */
export function judgeScope(input: {
  readonly files: ReadonlyArray<ChangedFile>;
  readonly manifests: ReadonlyArray<ManifestChange>;
  readonly likelyAreas: ReadonlyArray<string>;
}): ReadonlyArray<CardScopeFlag> {
  const flags: Array<CardScopeFlag> = [];
  for (const file of input.files) {
    if (file.status === "deleted" && TEST_FILE.test(file.path)) {
      flags.push({ kind: "deletedTest", path: file.path, detail: "A test file was deleted.", hard: true });
    }
    const skipped = file.addedLines.find((line) => SKIPPED_TEST.test(line));
    if (skipped !== undefined) {
      flags.push({ kind: "skippedTest", path: file.path, detail: skipped.trim().slice(0, 200), hard: true });
    }
    if (PROTECTED.some((pattern) => pattern.test(file.path))) {
      flags.push({
        kind: "protectedPath",
        path: file.path,
        detail: "Iskra's project config and CI workflows change only with a person's say-so.",
        hard: true,
      });
    }
  }
  for (const manifest of input.manifests) {
    const before = dependenciesOf(manifest.before);
    const after = dependenciesOf(manifest.after);
    for (const [name, range] of Object.entries(after)) {
      const was = before[name];
      const beforeVersion = was === undefined ? null : versionOf(was);
      const afterVersion = versionOf(range);
      if (beforeVersion !== null && afterVersion !== null && isLower(afterVersion, beforeVersion)) {
        flags.push({
          kind: "dependencyDowngrade",
          path: manifest.path,
          detail: `${name} ${was} → ${range}`,
          hard: true,
        });
      }
    }
  }
  if (input.likelyAreas.length > 0) {
    const areas = input.likelyAreas.map((area) => area.replace(/^\.?\//, "").replace(/\*+.*$/, ""));
    const outside = input.files.filter(
      (file) => !areas.some((area) => area.length === 0 || file.path.startsWith(area)),
    );
    outside.slice(0, OUTSIDE_AREA_FLAG_LIMIT).forEach((file, index, shown) => {
      const more = outside.length - shown.length;
      flags.push({
        kind: "outsideLikelyAreas",
        path: file.path,
        detail:
          index === shown.length - 1 && more > 0
            ? `Outside the estimate's likely areas, with ${more} more.`
            : "Outside the estimate's likely areas.",
        hard: false,
      });
    });
  }
  return flags;
}

/** Parses `git diff --name-status` and `git diff -U0` output into changed files with added lines. */
export function changedFilesOf(nameStatus: string, patch: string): ReadonlyArray<ChangedFile> {
  const added = new Map<string, Array<string>>();
  let current: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      current = line === "+++ /dev/null" ? null : line.slice(4).replace(/^b\//, "");
      if (current !== null && !added.has(current)) added.set(current, []);
    } else if (current !== null && line.startsWith("+")) {
      added.get(current)!.push(line.slice(1));
    }
  }
  return nameStatus
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [status = "", ...paths] = line.split("\t");
      const path = paths.at(-1) ?? "";
      return {
        path,
        status: status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "modified",
        addedLines: added.get(path) ?? [],
      } as const;
    });
}

/** What the scope judge reads from a worktree: its commits since `base`, as files and manifests. */
export const inspectChanges = Effect.fn("CardEvidence.inspectChanges")(function* (input: {
  readonly worktreePath: string;
  readonly base: string;
}) {
  const runner = yield* ProcessRunner;
  const git = (args: ReadonlyArray<string>) =>
    runner
      .run({
        command: "git",
        args: ["-C", input.worktreePath, ...args],
        timeout: "60 seconds",
        maxOutputBytes: 8 * 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.map((output) => (output.code === 0 ? output.stdout : "")));
  const range = `${input.base}...HEAD`;
  const files = changedFilesOf(
    yield* git(["diff", "--name-status", "-M", range]),
    yield* git(["diff", "-U0", "--no-color", range]),
  );
  const mergeBase = (yield* git(["merge-base", input.base, "HEAD"])).trim();
  const show = (ref: string, path: string) =>
    ref.length === 0 ? Effect.succeed(null) : git(["show", `${ref}:${path}`]).pipe(Effect.map((text) => (text.length === 0 ? null : text)));
  const manifests: Array<ManifestChange> = [];
  for (const file of files.filter((candidate) => /(^|\/)package\.json$/.test(candidate.path))) {
    manifests.push({
      path: file.path,
      before: yield* show(mergeBase, file.path),
      after: file.status === "deleted" ? null : yield* show("HEAD", file.path),
    });
  }
  const headSha = (yield* git(["rev-parse", "HEAD"])).trim();
  return { files, manifests, headSha };
});

const gitIn = (
  worktreePath: string,
  args: ReadonlyArray<string>,
  timeout: Duration.Input = "2 minutes",
) =>
  Effect.flatMap(ProcessRunner, (runner) =>
    runner.run({ command: "git", args: ["-C", worktreePath, ...args], timeout }),
  );

/** Fetches the card's base from origin; a repository without one lands locally and skips it. */
export const fetchBase = Effect.fn("CardEvidence.fetchBase")(function* (input: {
  readonly worktreePath: string;
  readonly baseBranch: string;
}) {
  yield* gitIn(input.worktreePath, ["fetch", "--quiet", "origin", input.baseBranch]).pipe(
    Effect.ignore,
  );
});

/**
 * Commits what the owner left uncommitted and rebases the card's branch onto `baseRef`. A conflict
 * aborts the rebase and names the conflicting files. Run it under CardWorkspace.withCardLock, so
 * the card's ensure, land and teardown can't race it.
 * ponytail: a builder still editing the worktree mid-rebase isn't locked out; the review request
 * ends its turn first, which is all that keeps it away.
 */
export const commitAndRebase = Effect.fn("CardEvidence.commitAndRebase")(function* (input: {
  readonly worktreePath: string;
  readonly baseRef: string;
  readonly message: string;
}) {
  yield* gitIn(input.worktreePath, ["add", "-A"]);
  const staged = yield* gitIn(input.worktreePath, ["diff", "--cached", "--quiet"]);
  if (staged.code !== 0) {
    yield* gitIn(input.worktreePath, ["commit", "--quiet", "--no-verify", "-m", input.message]);
  }
  const rebased = yield* gitIn(input.worktreePath, ["rebase", "--quiet", input.baseRef], "5 minutes");
  if (rebased.code === 0) return { kind: "rebased" as const };
  const conflicts = yield* gitIn(input.worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
  yield* gitIn(input.worktreePath, ["rebase", "--abort"]);
  return {
    kind: "conflict" as const,
    files: conflicts.stdout.split("\n").filter((line) => line.trim().length > 0),
  };
});

// ---------------------------------------------------------------------------------------------
// UI evidence

/** What capturing UI evidence and inspecting a worktree need from the server. */
export type CaptureServices =
  | PreviewAutomationBroker.PreviewAutomationBroker
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | ProcessRunner;

/** Changed files that call for a screenshot of the running app. */
const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|html)$/;

export const uiEvidenceRequired = (files: ReadonlyArray<Pick<ChangedFile, "path" | "status">>) =>
  files.some((file) => file.status !== "deleted" && UI_FILE.test(file.path));

/** The thread a card's evidence captures run under, so they never share a tab with an agent. */
export const cardEvidenceThreadId = (cardId: CardId) => ThreadId.make(`card-evidence-${cardId}`);

export const NO_PREVIEW_HOST: Reason = {
  code: "noPreviewHost",
  text: "No desktop app was connected to capture the preview.",
};

/**
 * The preview URL for a card's own port, or null when the port isn't in the card's block. Captures
 * only ever reach loopback on the card's ports.
 */
export function evidenceUrl(input: {
  readonly port: number;
  readonly portBase: number;
  readonly path: string;
}): string | null {
  const { port, portBase } = input;
  if (!Number.isInteger(port) || port < portBase || port >= portBase + CARD_PORT_BLOCK_SIZE) {
    return null;
  }
  const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
  return /^\/[^\s#?]*(\?[^\s#]*)?$/.test(path) && !path.startsWith("//")
    ? `http://127.0.0.1:${port}${path}`
    : null;
}

const unavailableItem = (name: string, reason: Reason): CardEvidenceItem => ({
  itemId: `${name}:unavailable`,
  kind: "screenshot",
  source: "preview",
  name,
  criterionId: null,
  exitCode: null,
  timedOut: false,
  durationMs: null,
  logTail: "",
  artifactPath: null,
  unavailable: reason,
});

/**
 * Screenshots the card's running app at `paths`, through a connected desktop host. The card's run
 * script must already listen on `port`. Anything that stops a capture becomes an unavailable item:
 * missing UI evidence flags the card, it never fails the review.
 */
export const captureUiEvidence = Effect.fn("CardEvidence.captureUiEvidence")(function* (input: {
  readonly cardId: CardId;
  readonly environmentId: EnvironmentId;
  readonly port: number;
  readonly portBase: number;
  readonly paths: ReadonlyArray<string>;
  readonly evidenceId: string;
}) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadId = cardEvidenceThreadId(input.cardId);
  const scope = {
    environmentId: input.environmentId,
    threadId,
    providerSessionId: threadId,
    providerInstanceId: ProviderInstanceId.make("iskra"),
    capabilities: new Set(["preview" as const]),
    issuedAt: DateTime.toEpochMillis(yield* DateTime.now),
  };
  const segment = toSafeThreadAttachmentSegment(threadId) ?? "card-evidence";
  const directory = path.join(config.attachmentsDir, segment);
  const items: Array<CardEvidenceItem> = [];
  for (const [index, pagePath] of input.paths.entries()) {
    const name = `Preview ${pagePath}`;
    const url = evidenceUrl({ port: input.port, portBase: input.portBase, path: pagePath });
    if (url === null) {
      items.push(
        unavailableItem(name, {
          code: "previewUrlRefused",
          text: `Only the card's own ports on loopback are captured, not port ${input.port} path ${pagePath}.`,
        }),
      );
      continue;
    }
    const started = DateTime.toEpochMillis(yield* DateTime.now);
    const captured = yield* Effect.gen(function* () {
      yield* broker.invoke({ scope, operation: "open", input: { url, open: false, reuseExistingTab: true } });
      // The run script may still be starting: retry navigation for up to a minute.
      yield* broker
        .invoke({ scope, operation: "navigate", input: { url, readiness: "load", timeoutMs: 15_000 }, timeoutMs: 20_000 })
        .pipe(
          Effect.retry({
            while: (error) => error._tag !== "PreviewAutomationNoAvailableHostError",
            schedule: Schedule.spaced("3 seconds"),
            times: 15,
          }),
        );
      const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        operation: "snapshot",
        input: {},
        timeoutMs: 30_000,
      });
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const file = path.join(directory, `${input.evidenceId}-${index + 1}.png`);
      yield* fileSystem.writeFile(file, Buffer.from(snapshot.screenshot.data, "base64"));
      return file;
    }).pipe(
      Effect.map((file) => ({ ok: true as const, file })),
      // Anything but an interrupt becomes an unavailable item: a capture never fails a review.
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const error = Cause.squash(cause);
        const noHost =
          Predicate.isTagged(error, "PreviewAutomationNoAvailableHostError");
        return Effect.succeed({
          ok: false as const,
          reason: noHost
            ? NO_PREVIEW_HOST
            : {
                code: "previewFailed",
                text: `The preview couldn't be captured: ${error instanceof Error ? error.message : String(error)}`,
              },
        });
      }),
    );
    if (!captured.ok) {
      items.push(unavailableItem(name, captured.reason));
      if (captured.reason.code === NO_PREVIEW_HOST.code) break;
      continue;
    }
    items.push({
      itemId: `${name}:${index + 1}`,
      kind: "screenshot",
      source: "preview",
      name,
      criterionId: null,
      exitCode: null,
      timedOut: false,
      durationMs: DateTime.toEpochMillis(yield* DateTime.now) - started,
      logTail: "",
      artifactPath: captured.file,
      unavailable: null,
    });
  }
  return items;
});

/** The project's run script, which evidence captures start on the card's ports. */
export const runScriptOf = (scripts: ReadonlyArray<ProjectScript>) =>
  scripts.find((script) => script.role === "run") ?? null;
