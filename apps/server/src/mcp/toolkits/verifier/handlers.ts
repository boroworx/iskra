import { CommandId, type CardEvidenceItem, type OrchestrationCardShell, type ThreadId } from "@iskra/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { HoldoutStore, redactHoldouts } from "../../../orchestration/HoldoutStore.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  VerifierCommandRefusedError,
  VerifierScreenshotToolkit,
  VerifierSessionRequiredError,
  VerifierToolFailedError,
  VerifierToolkit,
} from "./tools.ts";

const SCREENSHOT_MAX_BYTES = 1_048_576;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface VerifierSession {
  readonly threadId: ThreadId;
  readonly card: OrchestrationCardShell;
  readonly headSha: string;
}

const makeSession = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const failed = (cause: unknown) => new VerifierToolFailedError({ cause });

  /**
   * The card and commit always come from the session the credential belongs to, never from the
   * tool's input: a verifier can only judge the card it was started on, at the commit being verified.
   */
  const requireVerifierSession = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("verifier");
    const run = yield* snapshots.getRunByThreadId(scope.threadId).pipe(Effect.mapError(failed));
    if (Option.isNone(run) || run.value.role !== "verifier" || run.value.cardId === null) {
      return yield* new VerifierSessionRequiredError({});
    }
    const card = yield* snapshots.getCardShellById(run.value.cardId).pipe(Effect.mapError(failed));
    if (
      Option.isNone(card) ||
      card.value.verification.state !== "running" ||
      card.value.verification.headSha === null
    ) {
      return yield* new VerifierSessionRequiredError({});
    }
    return {
      threadId: scope.threadId,
      card: card.value,
      headSha: card.value.verification.headSha,
    } satisfies VerifierSession;
  });

  const evidenceItem = (session: VerifierSession, itemId: string) =>
    Effect.gen(function* () {
      const activity = yield* snapshots.getCardActivity(session.card.id, 1).pipe(Effect.mapError(failed));
      const item = activity.evidence?.items.find((candidate) => candidate.itemId === itemId);
      if (item === undefined) {
        return yield* new VerifierCommandRefusedError({
          detail: `The card's latest evidence has no item ${itemId}.`,
        });
      }
      return item satisfies CardEvidenceItem;
    });

  return { failed, requireVerifierSession, evidenceItem };
});

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const holdouts = yield* Effect.serviceOption(HoldoutStore);
  const { failed, requireVerifierSession, evidenceItem } = yield* makeSession;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  return VerifierToolkit.of({
    record_verdict: (input) =>
      Effect.gen(function* () {
        const session = yield* requireVerifierSession;
        const scenarios = Option.isSome(holdouts)
          ? yield* holdouts.value.list(session.card.projectId).pipe(Effect.mapError(failed))
          : [];
        const judged = new Set(input.scenarios.map((scenario) => scenario.scenarioId));
        const missing = scenarios.filter((scenario) => !judged.has(scenario.scenarioId));
        if (missing.length > 0) {
          return yield* new VerifierCommandRefusedError({
            detail: `Say whether every hidden scenario is satisfied; missing ${missing.map((scenario) => scenario.scenarioId).join(", ")}.`,
          });
        }
        // What the verifier writes lands in the event log and in the builder's feedback.
        const clean = (text: string) => redactHoldouts(text, scenarios);
        const verdictId = `verdict-${yield* uuid}`;
        yield* engine
          .dispatch({
            type: "card.verdict.record",
            commandId: CommandId.make(`server:mcp-verifier-verdict:${session.threadId}:${verdictId}`),
            verdictId,
            cardId: session.card.id,
            headSha: session.headSha,
            criteria: input.criteria.map((criterion) => ({
              ...criterion,
              evidence: clean(criterion.evidence),
              note: clean(criterion.note),
            })),
            diffJudge: {
              matchesCriteria: input.diffJudge.matchesCriteria,
              concerns: input.diffJudge.concerns.map(clean),
            },
            scenarios: input.scenarios.filter((scenario) =>
              scenarios.some((known) => known.scenarioId === scenario.scenarioId),
            ),
            recordedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "OrchestrationCommandInvariantError"
                ? new VerifierCommandRefusedError({ detail: error.detail })
                : failed(error),
            ),
          );
        return { verdictId };
      }),
    view_evidence: (input) =>
      Effect.gen(function* () {
        const item = yield* evidenceItem(yield* requireVerifierSession, input.itemId);
        return {
          itemId: item.itemId,
          kind: item.kind,
          name: item.name,
          criterionId: item.criterionId,
          exitCode: item.exitCode,
          timedOut: item.timedOut,
          logTail: item.logTail,
          unavailable: item.unavailable?.text ?? null,
        };
      }),
  });
});

const makeScreenshot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { failed, requireVerifierSession, evidenceItem } = yield* makeSession;

  return VerifierScreenshotToolkit.of({
    view_screenshot: (input) =>
      Effect.gen(function* () {
        const item = yield* evidenceItem(yield* requireVerifierSession, input.itemId);
        if (item.kind !== "screenshot" || item.artifactPath === null) {
          return yield* new VerifierCommandRefusedError({
            detail: `Evidence item ${item.itemId} isn't a captured screenshot.`,
          });
        }
        const bytes = yield* fileSystem.readFile(item.artifactPath).pipe(Effect.mapError(failed));
        if (bytes.byteLength > SCREENSHOT_MAX_BYTES) {
          return yield* new VerifierCommandRefusedError({ detail: "The screenshot is larger than 1 MB." });
        }
        if (bytes.byteLength < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
          return yield* new VerifierCommandRefusedError({ detail: "The screenshot isn't a PNG." });
        }
        // The PNG header's IHDR chunk carries the image size.
        const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return {
          itemId: item.itemId,
          name: item.name,
          screenshot: {
            mimeType: "image/png" as const,
            data: Buffer.from(bytes).toString("base64"),
            width: header.getUint32(16),
            height: header.getUint32(20),
          },
        };
      }),
  });
});

export const VerifierToolkitHandlersLive = VerifierToolkit.toLayer(make);
export const VerifierScreenshotToolkitHandlersLive = VerifierScreenshotToolkit.toLayer(makeScreenshot);
