import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { ProviderOptionSelections } from "./model.ts";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import {
  AgentId,
  ApprovalRequestId,
  CardId,
  ChannelId,
  CheckpointRef,
  ClientSurface,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { UsageCostSource } from "./usage.ts";
import {
  PullRequestActor,
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestState,
} from "./pullRequest.ts";

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getWorkflowScript: "orchestration.getWorkflowScript",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  searchThreads: "orchestration.searchThreads",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  subscribeChannel: "orchestration.subscribeChannel",
  subscribeCard: "orchestration.subscribeCard",
  listAgentRuns: "orchestration.listAgentRuns",
  getCardDiff: "orchestration.getCardDiff",
  saveAgentDefinition: "orchestration.saveAgentDefinition",
  importAgentDefinitions: "orchestration.importAgentDefinitions",
  listAgentDefinitions: "orchestration.listAgentDefinitions",
  archiveAgentDefinition: "orchestration.archiveAgentDefinition",
  listArchivedChannels: "orchestration.listArchivedChannels",
  setProjectSecret: "project.secrets.set",
  removeProjectSecret: "project.secrets.remove",
} as const;

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

/**
 * `ModelSelection` — selection of a model on a configured provider instance.
 *
 * The routing key is `instanceId` (a user-defined slug identifying one
 * configured provider instance). Drivers, credentials, working-directory
 * bindings, and any other per-instance state are recovered from the
 * runtime registry via the instance id.
 *
 * Wire legacy: persisted selections produced before the driver/instance
 * split carried a `provider: <driver-id>` field instead. The schema absorbs
 * that shape via a pre-decoding transform — `{provider, model}` is promoted
 * to `{instanceId: defaultInstanceIdForDriver(provider), model}`. No
 * post-decode compatibility code lives in the runtime; the transform is the
 * only compat surface.
 */
const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

// Source shape for persisted legacy payloads. Fields are typed as
// `Schema.Unknown` so malformed drafts still make it into the transform and
// fail validation through the target schema (with proper error messages)
// rather than at the source-struct layer where the error is less actionable.
const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        // Resolve the routing key: prefer an explicit `instanceId`; fall
        // back to promoting the legacy `provider` slug (the canonical
        // `defaultInstanceIdForDriver` mapping) so persisted rollout-era
        // payloads decode without data loss. The target schema brands the
        // string as `ProviderInstanceId`.
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          model: value.model,
          instanceId: value.instanceId,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderApprovalOption = Schema.Struct({
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
  /** Provider-supplied caution shown next to the option, such as a prompt injection warning. */
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderApprovalOption = typeof ProviderApprovalOption.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET = new Set<string>(
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
);

/** Whether a pasted or picked image mime type can be sent on a provider turn. */
export function isProviderSendTurnSupportedImageMimeType(mimeType: string): boolean {
  return PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET.has(mimeType.toLowerCase());
}
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS = 32_000;
export const SNAP_SHOT_ACCESSIBILITY_MAX_NODES = 10_000;
export const SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS = 32_000;

const SnapShotAccessibilityBounds = Schema.Struct({
  x: NonNegativeInt,
  y: NonNegativeInt,
  width: PositiveInt,
  height: PositiveInt,
});

const SnapShotAccessibilityState = Schema.Struct({
  active: Schema.optional(Schema.Boolean),
  busy: Schema.optional(Schema.Boolean),
  checked: Schema.optional(Schema.Literals(["on", "off", "mixed"])),
  editable: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
  expanded: Schema.optional(Schema.Boolean),
  focused: Schema.optional(Schema.Boolean),
  selected: Schema.optional(Schema.Boolean),
  visible: Schema.optional(Schema.Boolean),
});

export interface SnapShotAccessibilityNode {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly bounds: typeof SnapShotAccessibilityBounds.Type | null;
  readonly state?: typeof SnapShotAccessibilityState.Type;
  readonly actions?: Array<string>;
  readonly children: Array<SnapShotAccessibilityNode>;
}

export const SnapShotAccessibilityNode: Schema.Codec<SnapShotAccessibilityNode> = Schema.Struct({
  role: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(1_000))),
  value: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(8_000))),
  description: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  bounds: Schema.NullOr(SnapShotAccessibilityBounds),
  state: Schema.optionalKey(SnapShotAccessibilityState),
  actions: Schema.optionalKey(
    Schema.mutable(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(100)))).check(
      Schema.isMaxLength(32),
    ),
  ),
  children: Schema.mutable(
    Schema.Array(
      Schema.suspend((): Schema.Codec<SnapShotAccessibilityNode> => SnapShotAccessibilityNode),
    ),
  ).check(Schema.isMaxLength(SNAP_SHOT_ACCESSIBILITY_MAX_NODES)),
});

const SnapShotAccessibilityWire = Schema.Union([
  Schema.Struct({
    format: Schema.Literal("flat-text"),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS)),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    format: Schema.Literal("element-tree"),
    coordinateSpace: Schema.Literal("captured-image"),
    imageSize: Schema.Struct({ width: PositiveInt, height: PositiveInt }),
    truncated: Schema.Boolean,
    root: SnapShotAccessibilityNode,
  }),
]);
export const SnapShotAccessibility = SnapShotAccessibilityWire.check(
  Schema.makeFilter((accessibility: typeof SnapShotAccessibilityWire.Type) => {
    if (accessibility.format === "flat-text") return undefined;
    let nodes = 0;
    const stack = [accessibility.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      nodes += 1;
      if (nodes > SNAP_SHOT_ACCESSIBILITY_MAX_NODES) {
        return `Accessibility trees must not exceed ${SNAP_SHOT_ACCESSIBILITY_MAX_NODES} nodes.`;
      }
      stack.push(...node.children);
    }
    return (
      JSON.stringify(accessibility).length <= SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS ||
      `Accessibility trees must not exceed ${SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS} serialized characters.`
    );
  }),
);
export type SnapShotAccessibility = typeof SnapShotAccessibility.Type;

export const SnapShotSource = Schema.Struct({
  kind: Schema.Literal("snap-shot"),
  capturedAt: IsoDateTime,
  appName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  windowTitle: TrimmedString.check(Schema.isMaxLength(1_000)),
  accessibleText: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS)),
  ),
  accessibility: Schema.optional(SnapShotAccessibility),
  appIdentifier: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  appIconDataUrl: Schema.optional(
    TrimmedNonEmptyString.check(
      Schema.isMaxLength(100_000),
      Schema.isPattern(/^data:image\/png;base64,/i),
    ),
  ),
});
export type SnapShotSource = typeof SnapShotSource.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  source: Schema.optional(SnapShotSource),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const PastedTextAttachmentSource = Schema.TaggedStruct("pasted-text", {});
export type PastedTextAttachmentSource = typeof PastedTextAttachmentSource.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  ),
  /** Clipboard text folded by a client. Providers keep these path-only so the
      agent can inspect the file selectively instead of eagerly spending the
      same context the fold is intended to preserve. */
  source: Schema.optional(PastedTextAttachmentSource),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

/**
 * Catch-all for attachment types this build does not know. Attachments ride on
 * persisted events and thread streams, so a newer server or client must be able
 * to introduce a type without making older readers fail to decode the whole
 * message. Decoders keep the shared base fields; consumers skip these or render
 * them as unsupported. Mirrors how `OrchestrationThreadActivity` keeps `kind`
 * open. The known discriminators are excluded so a malformed image or file
 * attachment fails its own schema instead of sliding through here with its
 * size and mime constraints unchecked.
 */
export const ChatUnknownAttachment = Schema.Struct({
  type: TrimmedNonEmptyString.check(
    Schema.isMaxLength(50),
    Schema.isPattern(/^(?!(?:image|file)$)/),
  ),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
});
export type ChatUnknownAttachment = typeof ChatUnknownAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  /** Client-side id, so context records can bind to the attachment before it has a server id. */
  id: Schema.optional(ChatAttachmentId),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
  source: Schema.optional(SnapShotSource),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatUnknownAttachment,
]);
export type ChatAttachment = typeof ChatAttachment.Type;

export const UserInputAttachments = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Union([ChatImageAttachment, ChatFileAttachment])).pipe(
    Schema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
);
export type UserInputAttachments = typeof UserInputAttachments.Type;

export const UserInputAttachmentAnswerPayload = Schema.Struct({
  requestId: ApprovalRequestId,
  questionTextById: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: UserInputAttachments,
});
export type UserInputAttachmentAnswerPayload = typeof UserInputAttachmentAnswerPayload.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

/** What a script does for a card's worktree: prepare it, run the app, or clean up before removal. */
export const ProjectScriptRole = Schema.Literals(["setup", "run", "archive", "check"]);
export type ProjectScriptRole = typeof ProjectScriptRole.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  // Optional so scripts saved before roles still decode; `runOnWorktreeCreate` is the legacy setup flag.
  role: Schema.optional(ProjectScriptRole),
  // For a script that shares a port or database: starting it on one card stops it on the others.
  exclusive: Schema.optional(Schema.Boolean),
  /**
   * URL to open in the in-app browser preview when this script runs (or
   * when the user explicitly requests a preview). Optional; only honored on
   * the desktop build.
   */
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  /**
   * When true, automatically open the preview panel pointed at `previewUrl`
   * the moment this script starts. Ignored without `previewUrl` or on web.
   */
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i),
);
export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

export const ProjectIconColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type ProjectIconColor = typeof ProjectIconColor.Type;

const ProjectLucideIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

const ProjectEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(32));

export const ProjectIconOverride = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("lucide"),
    name: ProjectLucideIconName,
    color: ProjectIconColor,
  }),
  Schema.Struct({
    kind: Schema.Literal("emoji"),
    emoji: ProjectEmoji,
  }),
]);
export type ProjectIconOverride = typeof ProjectIconOverride.Type;

/** A card's spending cap until a person raises it. */
export const DEFAULT_CARD_BUDGET_USD = 10;

/** Why something automated happened or waits, as people and agents read it. */
export const Reason = Schema.Struct({
  code: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
});
export type Reason = typeof Reason.Type;

/** How a card's work lands: a pull request on the host, or a local fast-forward. */
export const ProjectLandingMode = Schema.Literals(["pullRequest", "local"]);
export type ProjectLandingMode = typeof ProjectLandingMode.Type;

/**
 * A project's orchestration policy: everything the decider enforces or that widens what agents
 * may do. Changed only by a person's `project.orchestration.set`; no tool or reactor sends it.
 * Every field decodes to its default, so an absent or older policy reads as the defaults.
 */
export const ProjectOrchestration = Schema.Struct({
  // The branch cards start from and land into; null uses the repository's default branch.
  baseBranch: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Owner sessions live at once in this project; null leaves only the environment's cap.
  sessionCap: Schema.NullOr(PositiveInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // Agent pull requests waiting on a person before new cards start.
  openAgentPrCap: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(5))),
  // Null opens a pull request when a remote and host auth exist, and lands locally otherwise.
  landing: Schema.NullOr(ProjectLandingMode).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  ciFixRounds: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(2))),
  reviewFixRounds: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(2))),
  budgets: Schema.Struct({
    projectUsd: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
    perAgentUsd: Schema.NullOr(Schema.Number).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
    cardDefaultUsd: Schema.Number.pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_CARD_BUDGET_USD)),
    ),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // A person's choice to let review proceed without any check script.
  checksWaived: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  autoMerge: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    minSatisfaction: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0.9))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Paths one card at a time may land changes to, with what others run after rebasing onto it.
  exclusivePaths: Schema.Array(
    Schema.Struct({
      glob: TrimmedNonEmptyString,
      afterRebase: Schema.NullOr(TrimmedNonEmptyString).pipe(
        Schema.withDecodingDefault(Effect.succeed(null)),
      ),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  // What agent shells may reach: nothing, or only the allowed domains.
  egress: Schema.Struct({
    mode: Schema.Literals(["none", "allowlist"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("none" as const)),
    ),
    allow: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    deny: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Owner sessions start only once a person reviewed the project's scheduled and outbound jobs.
  sideEffectGuard: Schema.Struct({
    acknowledgedAt: Schema.NullOr(IsoDateTime).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
    killSwitchEnv: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Commands agents run only through run_checks, such as the full test suite.
  heavyCommands: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  builderSubCardsMax: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(8))),
});
export type ProjectOrchestration = typeof ProjectOrchestration.Type;

export const DEFAULT_PROJECT_ORCHESTRATION: ProjectOrchestration = Schema.decodeSync(
  ProjectOrchestration,
)({});

/** A project's policy, defaults included when it never set one. */
export const projectOrchestrationOf = (project: {
  readonly orchestration?: ProjectOrchestration | undefined;
}): ProjectOrchestration => project.orchestration ?? DEFAULT_PROJECT_ORCHESTRATION;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // Per-project override for where new threads start. Null/absent means
  // "no override": clients fall back to iskra.json, then the global setting.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Opt-in because background sync performs network I/O and may move the checkout.
  // Optional on the wire so cached snapshots from older servers still decode.
  autoPull: Schema.optional(Schema.Boolean),
  // Optional on the wire so cached snapshots from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.Array(ProjectScript),
  // Absent until a person sets one; read it through `projectOrchestrationOf`.
  orchestration: Schema.optional(ProjectOrchestration),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

/** What a run may do. Anything not listed is denied at the adapter boundary. */
export const RunCapability = Schema.Literals(["read", "write", "shell", "network"]);
export type RunCapability = typeof RunCapability.Type;
export const RunCapabilities = Schema.Array(RunCapability);
export type RunCapabilities = typeof RunCapabilities.Type;

const AGENT_NAME_MAX_CHARS = 64;
/** Agents are addressed as `@name`, so names are lowercase slugs. */
export const AgentName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_NAME_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9-]+$/),
);

export const OrchestrationAgent = Schema.Struct({
  id: AgentId,
  projectId: ProjectId,
  name: AgentName,
  avatar: Schema.NullOr(TrimmedNonEmptyString),
  roleTags: Schema.Array(TrimmedNonEmptyString),
  rolePrompt: Schema.String,
  modelSelection: ModelSelection,
  // Ceiling for card-scoped runs; conversation runs are always read-only.
  capabilities: RunCapabilities,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationAgent = typeof OrchestrationAgent.Type;

export const ChannelKind = Schema.Literals(["channel", "dm"]);
export type ChannelKind = typeof ChannelKind.Type;

/** Messages of channel history handed to an agent when it wakes. */
export const DEFAULT_CHANNEL_WAKE_DEPTH = 30;

export const OrchestrationChannel = Schema.Struct({
  id: ChannelId,
  projectId: ProjectId,
  kind: ChannelKind,
  name: TrimmedNonEmptyString,
  topic: Schema.String,
  pinnedSpec: Schema.String,
  wakeDepth: NonNegativeInt,
  // A `dm` has exactly one agent; its human is implicit until there is more than one.
  memberAgentIds: Schema.Array(AgentId),
  // The agent woken by messages that mention no one; it only proposes triage cards.
  leadAgentId: Schema.NullOr(AgentId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // The lead's questions nobody has answered yet, with the options each offers.
  openElicitations: Schema.optional(
    Schema.Array(
      Schema.Struct({ messageId: MessageId, optionIds: Schema.Array(TrimmedNonEmptyString) }),
    ),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationChannel = typeof OrchestrationChannel.Type;

/**
 * A card is a feature: one unit of work with its own branch. Its status is
 * derived from what happened to it; humans only approve, assign, approve the
 * merge and abandon, plus the reverse of each.
 */
export const CardStatus = Schema.Literals([
  "triage",
  "ready",
  "inProgress",
  "inReview",
  "landing",
  "landed",
  "abandoned",
]);
export type CardStatus = typeof CardStatus.Type;

export const CardSpecState = Schema.Literals(["draft", "approved", "skipped"]);
export type CardSpecState = typeof CardSpecState.Type;

export const CardRelationKind = Schema.Literals([
  "blocks",
  "blockedBy",
  "duplicateOf",
  "related",
  "overlaps",
]);
export type CardRelationKind = typeof CardRelationKind.Type;

export const CardRelation = Schema.Struct({
  kind: CardRelationKind,
  cardId: CardId,
});
export type CardRelation = typeof CardRelation.Type;

export const CardAuthorKind = Schema.Literals(["human", "agent", "lead", "linear"]);
export type CardAuthorKind = typeof CardAuthorKind.Type;

export const CardAuthor = Schema.Struct({
  kind: CardAuthorKind,
  id: TrimmedNonEmptyString,
});
export type CardAuthor = typeof CardAuthor.Type;

/** Why a card's status changed: a human decision, its reverse, or something that happened. */
export const CardMove = Schema.Literals([
  "approve",
  "unapprove",
  "workStarted",
  "requestReview",
  "returnToWork",
  "approveMerge",
  "cancelLanding",
  "landed",
  "abandon",
  "reopen",
  // A plan child or an auto-merge project entering landing with no person's approval.
  "beginLanding",
  // A person merged the card's pull request on its host: the card lands from review or landing.
  "mergedOnHost",
]);
export type CardMove = typeof CardMove.Type;

/** A card's changes against its base branch, as `git diff --stat` counts them. */
export const CardDiffStat = Schema.Struct({
  files: NonNegativeInt,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type CardDiffStat = typeof CardDiffStat.Type;

/** A card's project checks: running, or how the last run ended and how many failed in a row. */
export const CardChecks = Schema.Struct({
  state: Schema.Literals(["running", "passed", "failed"]),
  failedRuns: NonNegativeInt,
  // The failing scripts and the tail of their output, or why nothing ran.
  summary: Schema.String,
  updatedAt: IsoDateTime,
});
export type CardChecks = typeof CardChecks.Type;

/** Failed check runs in a row after which a card stops going back to its agent and waits for a person. */
export const CARD_AUTOFIX_ATTEMPTS = 3;

/** How many attempts a person can start on one card at a time. */
export const CARD_ATTEMPTS_MIN = 2;
export const CARD_ATTEMPTS_MAX = 4;

/** Ports reserved for each card's worktree, starting at its `portBase` (ISKRA_PORT). */
export const CARD_PORT_BLOCK_SIZE = 10;

/** How urgent a card is, on Linear's scale: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const CardPriority = Schema.Literals([0, 1, 2, 3, 4]);
export type CardPriority = typeof CardPriority.Type;

/**
 * The Linear issue a card syncs with. `title`, `description` and `stateId` are the values both
 * sides agreed on at the last sync, so whichever side differs from them is the side that changed.
 */
export const CardLinearIssue = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  teamId: TrimmedNonEmptyString,
  title: Schema.String,
  description: Schema.String,
  stateId: Schema.String,
  priority: CardPriority.pipe(Schema.withDecodingDefault(Effect.succeed(0 as const))),
  // The newest Linear comment already brought into the card.
  commentsSyncedAt: Schema.NullOr(IsoDateTime),
  // The Linear agent session the delegate's work shows in, once one is opened.
  agentSessionId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // The newest prompt from that session already brought into the card.
  promptsSyncedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type CardLinearIssue = typeof CardLinearIssue.Type;

/** A plan card breaks its work into child cards that land into the plan's own branch. */
export const CardKind = Schema.Literals(["task", "plan"]);
export type CardKind = typeof CardKind.Type;

/**
 * One observable outcome the card's work is held to. `manual` criteria (such as mobile UI) are
 * checked by a person at review; `automated` ones by checks and captured evidence.
 */
export const CardCriterion = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  verification: Schema.Literals(["automated", "manual"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("automated" as const)),
  ),
});
export type CardCriterion = typeof CardCriterion.Type;

/** A card's acceptance criteria, which only a person confirms. */
export const CardAcceptance = Schema.Struct({
  criteria: Schema.Array(CardCriterion),
  state: Schema.Literals(["draft", "confirmed"]),
});
export type CardAcceptance = typeof CardAcceptance.Type;

/** Criteria of cards from before acceptance criteria: none, and nothing to confirm. */
export const LEGACY_CARD_ACCEPTANCE: CardAcceptance = { criteria: [], state: "confirmed" };

/** The proposer's sizing of a card, shown before it starts. */
export const CardEstimate = Schema.Struct({
  size: Schema.Literals(["S", "M", "L", "XL"]),
  likelyAreas: Schema.Array(TrimmedNonEmptyString),
  risks: Schema.Array(TrimmedNonEmptyString),
  // A suggestion to split the card instead, with the smaller cards it would become.
  split: Schema.NullOr(
    Schema.Struct({
      reason: TrimmedNonEmptyString,
      cards: Schema.Array(
        Schema.Struct({
          title: TrimmedNonEmptyString,
          criteria: Schema.Array(TrimmedNonEmptyString),
        }),
      ),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type CardEstimate = typeof CardEstimate.Type;

/** What the requester wants and whether the proposed card gets there. */
export const CardPremise = Schema.Struct({
  goal: TrimmedNonEmptyString,
  getsThere: Schema.Boolean,
  pushback: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type CardPremise = typeof CardPremise.Type;

/** What sent a card back to work: failing checks or CI, or review feedback. */
export const CardFixRound = Schema.Literals(["ci", "review"]);
export type CardFixRound = typeof CardFixRound.Type;

/** Automatic returns to work used so far; capped by the project's fix rounds until a person resets them. */
export const CardFixRounds = Schema.Struct({
  ci: NonNegativeInt,
  review: NonNegativeInt,
});
export type CardFixRounds = typeof CardFixRounds.Type;

/** A card held out of the queue by a person or by Iskra itself, and why. */
export const CardPause = Schema.Struct({
  reason: Reason,
  by: Schema.Literals(["human", "system"]),
  pausedAt: IsoDateTime,
});
export type CardPause = typeof CardPause.Type;

/** Why a card that could run is waiting, such as for a session slot or machine capacity. */
export const CardWaitReason = Schema.Struct({
  ...Reason.fields,
  since: IsoDateTime,
});
export type CardWaitReason = typeof CardWaitReason.Type;

/** The owner's open request to show a person its work so far before going on. */
export const CardCheckpoint = Schema.Struct({
  checkpointId: TrimmedNonEmptyString,
  whatToTry: TrimmedNonEmptyString,
  question: Schema.NullOr(TrimmedNonEmptyString),
  // The evidence captured for this checkpoint, once there is some.
  evidenceId: Schema.NullOr(TrimmedNonEmptyString),
  requestedAt: IsoDateTime,
});
export type CardCheckpoint = typeof CardCheckpoint.Type;

export const CardCheckpointDecision = Schema.Literals(["continue", "redirect", "stop"]);
export type CardCheckpointDecision = typeof CardCheckpointDecision.Type;

/** A change the scope judge flags; a hard flag needs a person's acknowledgement before merging. */
export const CardScopeFlag = Schema.Struct({
  kind: Schema.Literals([
    "deletedTest",
    "skippedTest",
    "dependencyDowngrade",
    "protectedPath",
    "outsideLikelyAreas",
  ]),
  path: TrimmedNonEmptyString,
  detail: Schema.String,
  hard: Schema.Boolean,
});
export type CardScopeFlag = typeof CardScopeFlag.Type;

const CardRiskLevel = Schema.Literals(["low", "medium", "high"]);

/** The owner's own claims about its change's risks, shown as claims, never as evidence. */
export const CardRiskClaims = Schema.Struct({
  sideEffect: CardRiskLevel,
  performance: CardRiskLevel,
  compatibility: CardRiskLevel,
  notes: Schema.String,
});
export type CardRiskClaims = typeof CardRiskClaims.Type;

/** One piece of captured evidence: a check's result, or a screenshot or recording of the preview. */
export const CardEvidenceItem = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  kind: Schema.Literals(["check", "screenshot", "recording"]),
  source: Schema.Literals(["local", "ci", "preview"]),
  name: TrimmedNonEmptyString,
  criterionId: Schema.NullOr(TrimmedNonEmptyString),
  // A check's exit code; null for captures and for a check that never exited.
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  durationMs: Schema.NullOr(NonNegativeInt),
  // The end of the output, the only part agents see.
  logTail: Schema.String,
  artifactPath: Schema.NullOr(TrimmedNonEmptyString),
  // Why this item could not be captured, such as no connected preview host.
  unavailable: Schema.NullOr(Reason),
});
export type CardEvidenceItem = typeof CardEvidenceItem.Type;

export const CardEvidencePurpose = Schema.Literals(["review", "checkpoint"]);
export type CardEvidencePurpose = typeof CardEvidencePurpose.Type;

/** The latest evidence a card has, as its face shows it; the items stream with the card. */
export const CardEvidenceSummary = Schema.Struct({
  evidenceId: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  purpose: CardEvidencePurpose,
  passed: Schema.Boolean,
  checkCount: NonNegativeInt,
  failedChecks: Schema.Array(TrimmedNonEmptyString),
  unavailable: Schema.Array(TrimmedNonEmptyString),
  // CI checks on the pull request with no result yet; a merge waits for them.
  pendingCi: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  flags: Schema.Array(CardScopeFlag),
  flagsAcknowledgedAt: Schema.NullOr(IsoDateTime),
  recordedAt: IsoDateTime,
});
export type CardEvidenceSummary = typeof CardEvidenceSummary.Type;

/** Where a card's work lands: its pull request, or the local branch it fast-forwards. */
export const CardLanding = Schema.Struct({
  mode: ProjectLandingMode,
  url: Schema.NullOr(TrimmedNonEmptyString),
  number: Schema.NullOr(PositiveInt),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  draft: Schema.Boolean,
  linkedAt: IsoDateTime,
});
export type CardLanding = typeof CardLanding.Type;

/** What a question is for: the owner asking, a checkpoint, or a proposed change to the criteria. */
export const ElicitationKind = Schema.Literals(["question", "checkpoint", "criteriaChange"]);
export type ElicitationKind = typeof ElicitationKind.Type;

/** A question on a card nobody has answered yet: its activity, what it is for and its options. */
export const CardOpenElicitation = Schema.Struct({
  activityId: TrimmedNonEmptyString,
  kind: ElicitationKind,
  // Empty for a question answered in a person's own words only.
  optionIds: Schema.Array(TrimmedNonEmptyString),
  askedAt: IsoDateTime,
});
export type CardOpenElicitation = typeof CardOpenElicitation.Type;

/** Why a card lands without a person approving its merge. */
export const CardLandingBeginReason = Schema.Literals(["planChild", "autoMergePolicy"]);
export type CardLandingBeginReason = typeof CardLandingBeginReason.Type;

export const OrchestrationCard = Schema.Struct({
  id: CardId,
  projectId: ProjectId,
  // The channel it was proposed in, if any.
  channelId: Schema.NullOr(ChannelId),
  parentCardId: Schema.NullOr(CardId),
  title: TrimmedNonEmptyString,
  spec: Schema.String,
  specState: CardSpecState,
  tags: Schema.Array(TrimmedNonEmptyString),
  status: CardStatus,
  // The accountable person; the single local human until multiplayer.
  ownerHumanId: TrimmedNonEmptyString,
  // The only agent that writes on the card.
  delegateAgentId: Schema.NullOr(AgentId),
  // Null means the repository's default branch, resolved when the card's worktree is created.
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  // The card's own branch and worktree: set when work starts, cleared when it lands or is abandoned.
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  // The first of the card's CARD_PORT_BLOCK_SIZE ports, handed to its scripts as ISKRA_PORT.
  portBase: Schema.NullOr(PositiveInt),
  // Out of Needs you until `snoozedUntil` passes (null: until new activity), or
  // until the card has activity after `snoozedAt`.
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
  // When something last happened on the card that a person might act on.
  activityAt: IsoDateTime,
  // The worktree's changes against the base, measured when an owner turn settles.
  diffStat: Schema.NullOr(CardDiffStat),
  // The last run of the project's check scripts, from review or landing.
  checks: Schema.NullOr(CardChecks),
  // What the card's sessions have cost, priced like the usage page; no turn starts past the cap.
  spentUsd: Schema.Number,
  budgetCapUsd: Schema.Number,
  // Turns on a model with no known price, which run only once a person accepts running uncapped.
  unpricedTurns: NonNegativeInt,
  acceptsUnpriced: Schema.Boolean,
  // Times checks, a review comment or landing sent the card back to work.
  reviewReturns: NonNegativeInt,
  // Set on the sibling sub-cards of one best-of-N run; an attempt never lands on its own.
  attemptGroupId: Schema.NullOr(TrimmedNonEmptyString),
  linearIssue: Schema.NullOr(CardLinearIssue).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // The channel message a lead proposed the card from.
  sourceMessageId: Schema.NullOr(MessageId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // Why the channel's lead proposed the card, for the person triaging it.
  proposalReasoning: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // The agent the lead suggested to own the card; set as its delegate only when a person starts it.
  suggestedAgentId: Schema.NullOr(AgentId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  priority: CardPriority.pipe(Schema.withDecodingDefault(Effect.succeed(0 as const))),
  // The card contract. Each decodes to a card from before it: a task, confirmed with no criteria.
  kind: CardKind.pipe(Schema.withDecodingDefault(Effect.succeed("task" as const))),
  acceptance: CardAcceptance.pipe(
    Schema.withDecodingDefault(Effect.succeed({ criteria: [], state: "confirmed" as const })),
  ),
  estimate: Schema.NullOr(CardEstimate).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  premise: Schema.NullOr(CardPremise).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  checkpoint: Schema.NullOr(CardCheckpoint).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  fixRounds: CardFixRounds.pipe(Schema.withDecodingDefault(Effect.succeed({ ci: 0, review: 0 }))),
  // The latest evidence, for the commit it was captured on.
  evidence: Schema.NullOr(CardEvidenceSummary).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  landing: Schema.NullOr(CardLanding).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  paused: Schema.NullOr(CardPause).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  waitReason: Schema.NullOr(CardWaitReason).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // When the card last became ready to run, which orders the queue after priority.
  queuedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // Questions on the card nobody has answered yet, oldest first.
  openElicitations: Schema.Array(CardOpenElicitation).pipe(
    Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<CardOpenElicitation>)),
  ),
  relations: Schema.Array(CardRelation),
  createdBy: CardAuthor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationCard = typeof OrchestrationCard.Type;

/** A card's contract fields as a card from before the contract reads them. */
export const LEGACY_CARD_CONTRACT = {
  kind: "task",
  acceptance: LEGACY_CARD_ACCEPTANCE,
  estimate: null,
  premise: null,
  checkpoint: null,
  fixRounds: { ci: 0, review: 0 },
  evidence: null,
  landing: null,
  paused: null,
  waitReason: null,
  queuedAt: null,
  openElicitations: [],
} as const satisfies Partial<OrchestrationCard>;

export const ChannelMessageAuthorKind = Schema.Literals(["human", "agent", "system", "webhook"]);
export type ChannelMessageAuthorKind = typeof ChannelMessageAuthorKind.Type;

/** Author id of every human message until multiplayer adds identities. */
export const CHANNEL_HUMAN_AUTHOR_ID = "human";

/** Author id of messages the server posts itself, such as a refused wake. */
export const CHANNEL_SYSTEM_AUTHOR_ID = "system";

/**
 * Where a message stands with an agent it woke. `queued` is a DM waiting for the
 * agent's conversation in another channel to end, `pending` waits for the agent's
 * next turn, `sent` rides a turn that has not started yet, `delivered` is in a
 * running turn, and `undelivered` never reached one and shows as unanswered.
 * A message is never `delivered` merely because it was sent (invariant 10).
 */
export const ChannelDeliveryStatus = Schema.Literals([
  "queued",
  "pending",
  "sent",
  "delivered",
  "undelivered",
]);
export type ChannelDeliveryStatus = typeof ChannelDeliveryStatus.Type;

export const ChannelMessageDelivery = Schema.Struct({
  agentId: AgentId,
  status: ChannelDeliveryStatus,
});
export type ChannelMessageDelivery = typeof ChannelMessageDelivery.Type;

/** A question with two or three answers to pick from, one of them recommended. */
export const Elicitation = Schema.Struct({
  question: TrimmedNonEmptyString,
  options: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      label: TrimmedNonEmptyString,
    }),
  ),
  recommendedOptionId: Schema.NullOr(TrimmedNonEmptyString),
  // Whether a written answer is accepted instead of an option.
  allowText: Schema.Boolean,
  // What the question is for; one recorded before kinds were reads as a plain question.
  kind: ElicitationKind.pipe(Schema.withDecodingDefault(Effect.succeed("question" as const))),
});
export type Elicitation = typeof Elicitation.Type;

/** What a message answers: the question's message or activity, and the option picked, if any. */
export const ElicitationAnswer = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  optionId: Schema.NullOr(TrimmedNonEmptyString),
});
export type ElicitationAnswer = typeof ElicitationAnswer.Type;

export const OrchestrationChannelMessage = Schema.Struct({
  id: MessageId,
  channelId: ChannelId,
  authorKind: ChannelMessageAuthorKind,
  authorId: TrimmedNonEmptyString,
  body: Schema.String,
  createdAt: IsoDateTime,
  // Set on an agent's reply: the run whose final answer it is.
  runThreadId: Schema.optional(ThreadId),
  // A human message's standing with each agent it woke.
  deliveries: Schema.optional(Schema.Array(ChannelMessageDelivery)),
  // A lead's question with options, and when a person answered it.
  elicitation: Schema.optional(Elicitation),
  answeredAt: Schema.optional(IsoDateTime),
  // The question a person's message answers.
  answers: Schema.optional(ElicitationAnswer),
});

export const CardActivityKind = Schema.Literals([
  "message",
  "decision",
  "plan",
  "elicitation",
  "response",
  "status",
  "evidence",
  "landing",
  "error",
  "critique",
  "help",
]);
export type CardActivityKind = typeof CardActivityKind.Type;

export const CardActivityAuthor = Schema.Struct({
  kind: Schema.Literals(["human", "agent", "system", "linear", "github"]),
  id: TrimmedNonEmptyString,
  // Set on a pull request comment: whether its author may direct work on the repository. An
  // untrusted comment is shown on the card and reaches the builder only when a person forwards it.
  trusted: Schema.optional(Schema.Boolean),
});
export type CardActivityAuthor = typeof CardActivityAuthor.Type;

/**
 * One entry in a card's activity: the single stream its messages, decisions, questions, status
 * moves and evidence are read from. `deliverTo` entries wait for that session's next turn, and
 * `delivery` says where they stand with it.
 */
export const CardActivity = Schema.Struct({
  activityId: TrimmedNonEmptyString,
  cardId: CardId,
  kind: CardActivityKind,
  author: CardActivityAuthor,
  body: Schema.String,
  runThreadId: Schema.NullOr(ThreadId),
  deliverTo: Schema.NullOr(Schema.Literals(["builder", "coordinator"])),
  delivery: Schema.NullOr(ChannelDeliveryStatus),
  elicitation: Schema.NullOr(Elicitation).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  answers: Schema.NullOr(ElicitationAnswer).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  status: Schema.NullOr(Schema.Struct({ from: CardStatus, to: CardStatus })).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  evidenceId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  reason: Schema.NullOr(Reason).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: IsoDateTime,
});
export type CardActivity = typeof CardActivity.Type;
export type OrchestrationChannelMessage = typeof OrchestrationChannelMessage.Type;

/** One channel message as an agent sees it, with its author resolved to a display name. */
export const RunContextMessage = Schema.Struct({
  messageId: MessageId,
  authorKind: ChannelMessageAuthorKind,
  authorName: TrimmedNonEmptyString,
  body: Schema.String,
  createdAt: IsoDateTime,
});
export type RunContextMessage = typeof RunContextMessage.Type;

/**
 * Everything an agent is handed when it wakes, before rendering to prompt text.
 * Stored with the run so the context inspector shows exactly what the run saw.
 */
export const RunContextPayload = Schema.Struct({
  agent: Schema.Struct({
    id: AgentId,
    name: AgentName,
    rolePrompt: Schema.String,
  }),
  channel: Schema.Struct({
    id: ChannelId,
    kind: ChannelKind,
    name: TrimmedNonEmptyString,
    topic: Schema.String,
  }),
  pinnedSpec: Schema.String,
  wakeDepth: NonNegativeInt,
  // The newest `wakeDepth` messages before the trigger, oldest first.
  history: Schema.Array(RunContextMessage),
  trigger: RunContextMessage,
  // What a channel's lead also reads: who works in the channel and the project's open cards.
  lead: Schema.optional(
    Schema.Struct({
      members: Schema.Array(
        Schema.Struct({
          name: AgentName,
          roleTags: Schema.Array(TrimmedNonEmptyString),
          // The first line of the agent's role prompt. Optional so earlier runs still decode.
          summary: Schema.optional(Schema.String),
        }),
      ),
      openCards: Schema.Array(
        Schema.Struct({ id: CardId, title: TrimmedNonEmptyString, status: CardStatus }),
      ),
    }),
  ),
});
export type RunContextPayload = typeof RunContextPayload.Type;

/** The exact text a run sends its provider, rendered from a `RunContextPayload`. */
export const RenderedRunContext = Schema.Struct({
  systemPrompt: Schema.String,
  firstMessage: Schema.String,
});
export type RenderedRunContext = typeof RenderedRunContext.Type;

/**
 * What a run is for: a conversation in a channel, the one session writing a
 * card (its owner), or a read-only helper answering a question on a card.
 */
export const RunRole = Schema.Literals(["conversation", "owner", "helper", "critic", "lead"]);
export type RunRole = typeof RunRole.Type;

export const CardSessionRole = Schema.Literals(["owner", "helper", "critic"]);
export type CardSessionRole = typeof CardSessionRole.Type;

/** A decision on a card as a session is handed it, with its author named. */
export const CardBriefDecision = Schema.Struct({
  authorName: TrimmedNonEmptyString,
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type CardBriefDecision = typeof CardBriefDecision.Type;

/**
 * The handoff brief: everything a card session is handed when it starts, before
 * rendering. Stored with the session so the inspector shows what it saw.
 */
export const CardBriefPayload = Schema.Struct({
  agent: Schema.Struct({
    id: AgentId,
    name: AgentName,
    rolePrompt: Schema.String,
  }),
  role: CardSessionRole,
  card: Schema.Struct({
    id: CardId,
    title: TrimmedNonEmptyString,
    spec: Schema.String,
    branch: Schema.NullOr(TrimmedNonEmptyString),
    baseBranch: TrimmedNonEmptyString,
  }),
  decisions: Schema.Array(CardBriefDecision),
  // The worktree's changes against the base branch, cut short when `diffTruncated`.
  diff: Schema.String,
  diffTruncated: Schema.Boolean,
  // What a helper was asked; null for an owner session.
  question: Schema.NullOr(Schema.String),
  // The card's worklog in the order it is handed over. Briefs from before the worklog render from
  // the fields above instead.
  sections: Schema.optional(
    Schema.Array(Schema.Struct({ title: TrimmedNonEmptyString, body: Schema.String })),
  ),
});
export type CardBriefPayload = typeof CardBriefPayload.Type;

/**
 * A run: one provider session backing an agent's work. It lives in a hidden
 * thread and records exactly what the agent was handed. A conversation run
 * has a channel and the message that woke it; a card session has a card.
 */
export const OrchestrationRun = Schema.Struct({
  threadId: ThreadId,
  role: RunRole,
  channelId: Schema.NullOr(ChannelId),
  cardId: Schema.NullOr(CardId),
  agentId: AgentId,
  triggerMessageId: Schema.NullOr(MessageId),
  capabilities: RunCapabilities,
  context: Schema.Union([RunContextPayload, CardBriefPayload]),
  rendered: RenderedRunContext,
  // Times the card's owner was restarted before this run.
  restarts: Schema.optional(NonNegativeInt),
  startedAt: IsoDateTime,
});
export type OrchestrationRun = typeof OrchestrationRun.Type;

/** A conversation run as `channel.run-started` records it. */
export const ChannelRun = Schema.Struct({
  threadId: ThreadId,
  // A lead run proposes cards and never replies. Absent on runs from before leads.
  role: Schema.optional(Schema.Literals(["conversation", "lead"])),
  channelId: ChannelId,
  agentId: AgentId,
  triggerMessageId: MessageId,
  capabilities: RunCapabilities,
  context: RunContextPayload,
  rendered: RenderedRunContext,
  startedAt: IsoDateTime,
});
export type ChannelRun = typeof ChannelRun.Type;

/** A card session as `card.session-started` records it. */
export const CardSession = Schema.Struct({
  threadId: ThreadId,
  cardId: CardId,
  agentId: AgentId,
  role: CardSessionRole,
  capabilities: RunCapabilities,
  context: CardBriefPayload,
  rendered: RenderedRunContext,
  // Times the card's owner was restarted before this session, counted by the scheduler.
  restarts: Schema.optional(NonNegativeInt),
  startedAt: IsoDateTime,
});
export type CardSession = typeof CardSession.Type;

/**
 * A run whose session has not yet stopped. An agent has at most one per
 * channel, and a card at most one owner.
 */
export const OrchestrationLiveRun = Schema.Struct({
  threadId: ThreadId,
  role: RunRole,
  channelId: Schema.NullOr(ChannelId),
  cardId: Schema.NullOr(CardId),
  agentId: AgentId,
  startedAt: IsoDateTime,
});
export type OrchestrationLiveRun = typeof OrchestrationLiveRun.Type;

/** The error a session is settled with when it did not survive a server restart. */
export const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";

/**
 * Where a run's session stands (Linear's agent session states): `pending` while
 * it starts, `active` while a turn runs, `awaitingInput` on an approval or a
 * question, `complete` when settled and waiting, `error` when it failed, `stale`
 * when it was lost across a restart without finishing, and `ended` once stopped.
 * Silence during a long tool call is `active`, not stale.
 */
export const RunSessionState = Schema.Literals([
  "pending",
  "active",
  "awaitingInput",
  "complete",
  "error",
  "stale",
  "ended",
]);
export type RunSessionState = typeof RunSessionState.Type;

export function runSessionState(input: {
  readonly endedAt: string | null;
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId" | "lastError"> | null;
  readonly awaitingInput: boolean;
}): RunSessionState {
  const { session } = input;
  if (session?.status === "error") {
    return session.lastError === ORPHANED_PROVIDER_SESSION_ERROR ? "stale" : "error";
  }
  if (input.endedAt !== null || session?.status === "stopped") {
    return "ended";
  }
  if (session === null || session.status === "starting") {
    return "pending";
  }
  if (input.awaitingInput) {
    return "awaitingInput";
  }
  return session.status === "running" || session.activeTurnId !== null ? "active" : "complete";
}

/** A run ends when its session stops or fails; a finished turn alone leaves it live. */
export const isRunEndingSessionStatus = (status: OrchestrationSessionStatus): boolean =>
  status === "stopped" || status === "error";

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  context: Schema.optional(OrchestrationMessageContext),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

/**
 * Legacy single-PR link. Still emitted as the thread's derived current pull
 * request (see `@iskra/shared/threadPullRequests`) so clients from before
 * `pullRequests` keep working independently of their release schedule.
 */
export const ThreadLinkedPullRequest = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ThreadLinkedPullRequest = typeof ThreadLinkedPullRequest.Type;

/** Who created a thread ↔ pull request link. `stack-dismissed` is a tombstone
 * for a native-stack member the user unlinked, so the sync reactor does not
 * re-add it; clients hide it. */
export const ThreadPullRequestLinkSource = Schema.Literals([
  "manual",
  "created",
  "agent",
  "stack",
  "stack-dismissed",
]);
export type ThreadPullRequestLinkSource = typeof ThreadPullRequestLinkSource.Type;

/**
 * Host state persisted on a link by the sync reactor; null until first sync. The overview
 * fields are optional: a host whose cheap read lacks them leaves them out, and snapshots
 * written before they existed still decode.
 */
export const ThreadPullRequestSnapshot = Schema.Struct({
  state: PullRequestState,
  title: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  isDraft: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoDateTime),
  syncedAt: IsoDateTime,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(PullRequestActor)),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  changedFiles: Schema.optional(NonNegativeInt),
  reviewDecision: Schema.optional(Schema.NullOr(PullRequestReviewDecision)),
  checksState: Schema.optional(Schema.NullOr(PullRequestChecksState)),
  mergeability: Schema.optional(PullRequestMergeability),
});
export type ThreadPullRequestSnapshot = typeof ThreadPullRequestSnapshot.Type;

export const ThreadPullRequestStackLayer = Schema.Struct({
  number: PositiveInt,
  headBranch: TrimmedNonEmptyString,
  state: PullRequestState,
});
export type ThreadPullRequestStackLayer = typeof ThreadPullRequestStackLayer.Type;

/** A host-native stack the pull request belongs to. Layers run bottom to top. */
export const ThreadPullRequestStack = Schema.Struct({
  kind: Schema.Literal("native"),
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
  layers: Schema.Array(ThreadPullRequestStackLayer),
});
export type ThreadPullRequestStack = typeof ThreadPullRequestStack.Type;

/** Identity of a pull request as a thread link sees it: host-level, so the
 * same PR linked from two projects (or two environments) compares equal. */
export const ThreadPullRequestKey = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ThreadPullRequestKey = typeof ThreadPullRequestKey.Type;

export const ThreadPullRequestLink = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadPullRequestSnapshot),
  stack: Schema.NullOr(ThreadPullRequestStack),
});
export type ThreadPullRequestLink = typeof ThreadPullRequestLink.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  // Optional so payloads from pre-link servers still decode.
  pullRequests: Schema.Array(ThreadPullRequestLink).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // When the thread last re-entered the active list (any thread.unsettled).
  // Anchors the active-list sort so an unsettled thread surfaces at the top
  // instead of sinking back to its creation-order slot. Cleared on settle.
  // Optional so payloads from pre-stamp servers still decode.
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Snooze is an overlay on the active lifecycle, not a fourth destination:
  // a snoozed thread stays "active" in the model and is only suppressed from
  // the inbox until snoozedUntil passes (or the thread raises its hand).
  // Optional so payloads from pre-snooze servers still decode.
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Active pinned threads render in the pinned block. Settled and snoozed
  // threads remain in their respective shelves even when pinned.
  // Optional so payloads from pre-pinning servers still decode.
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Fractional index for user-arranged pinned order. Keyed threads sort by
  // string comparison ahead of keyless ones (which keep creation order), so
  // servers never need each other's threads to agree on the merged list.
  // Optional so payloads from pre-reorder servers still decode.
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Manual Active placement. Keyless threads retain their creation/re-entry
  // order above the arranged run. Settling clears this slot.
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Pending-only state. Optional so older servers remain compatible.
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  // Optional on the wire so read models from servers without agents still decode.
  agents: Schema.optional(Schema.Array(OrchestrationAgent)),
  // Channel messages are not part of the read model; they are paged from the projection.
  channels: Schema.optional(Schema.Array(OrchestrationChannel)),
  // A card's decision log is not part of the read model; it is paged from the projection.
  cards: Schema.optional(Schema.Array(OrchestrationCard)),
  liveRuns: Schema.optional(Schema.Array(OrchestrationLiveRun)),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  autoPull: Schema.optional(Schema.Boolean),
  // Optional on the wire so cached snapshots from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.Array(ProjectScript),
  orchestration: Schema.optional(ProjectOrchestration),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  pullRequests: Schema.Array(ThreadPullRequestLink).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // See OrchestrationThread.unsettledAt: last re-entry into the active list.
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  /**
   * Native background work alive after the turn settles: "working" while
   * subagents/workflows run, "monitoring" when watch loops are the only
   * live work. Optional so old servers/clients interop; absent = none.
   */
  backgroundLiveness: Schema.optional(Schema.NullOr(Schema.Literals(["working", "monitoring"]))),
  /**
   * Current plan step while a turn runs, for the Working indicators
   * (sidebar row, in-chat working line). Cleared when the turn settles —
   * never persists as stale UI. Optional so old servers/clients interop.
   */
  planProgress: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        step: TrimmedNonEmptyString,
        completedSteps: NonNegativeInt,
        totalSteps: NonNegativeInt,
      }),
    ),
  ),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const AgentPresence = Schema.Literals(["idle", "running", "blocked"]);
export type AgentPresence = typeof AgentPresence.Type;

/** What a client needs to list an agent; its role prompt and model settings stay on the server. */
export const OrchestrationAgentShell = Schema.Struct({
  // `modelSelection` is the model the agent's DM starts on.
  ...Struct.pick(OrchestrationAgent.fields, [
    "id",
    "projectId",
    "name",
    "avatar",
    "roleTags",
    "modelSelection",
  ]),
  // Derived from the agent's live run: running while it has one, blocked while that run waits on the user.
  presence: AgentPresence,
  // What the agent's card sessions have cost across every card. Optional for older servers.
  spentUsd: Schema.optional(Schema.Number),
});
export type OrchestrationAgentShell = typeof OrchestrationAgentShell.Type;

/** What a client needs to list a channel; its pinned spec and history stay on the server. */
export const OrchestrationChannelShell = OrchestrationChannel.mapFields(
  Struct.pick(["id", "projectId", "kind", "name", "topic", "memberAgentIds", "leadAgentId"]),
);
export type OrchestrationChannelShell = typeof OrchestrationChannelShell.Type;

/** Where a card's latest owner session stands, for its face on the board and Needs you. */
export const OrchestrationCardSessionSummary = Schema.Struct({
  threadId: ThreadId,
  agentId: AgentId,
  state: RunSessionState,
  // When the session last changed state.
  since: IsoDateTime,
  planProgress: Schema.NullOr(
    Schema.Struct({
      step: TrimmedNonEmptyString,
      completedSteps: NonNegativeInt,
      totalSteps: NonNegativeInt,
    }),
  ),
});
export type OrchestrationCardSessionSummary = typeof OrchestrationCardSessionSummary.Type;

/** A card as the board shows it: the card and its latest owner session. */
export const OrchestrationCardShell = Schema.Struct({
  ...OrchestrationCard.fields,
  ownerSession: Schema.NullOr(OrchestrationCardSessionSummary),
});
export type OrchestrationCardShell = typeof OrchestrationCardShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  // Optional so cached snapshots and servers without agents still decode. Active entries only.
  agents: Schema.optional(Schema.Array(OrchestrationAgentShell)),
  channels: Schema.optional(Schema.Array(OrchestrationChannelShell)),
  cards: Schema.optional(Schema.Array(OrchestrationCardShell)),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
  // Sent only to subscribers that set `includeAgentChannels`; older clients reject unknown kinds.
  Schema.Struct({
    kind: Schema.Literal("agent-upserted"),
    sequence: NonNegativeInt,
    agent: OrchestrationAgentShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("agent-removed"),
    sequence: NonNegativeInt,
    agentId: AgentId,
  }),
  Schema.Struct({
    kind: Schema.Literal("channel-upserted"),
    sequence: NonNegativeInt,
    channel: OrchestrationChannelShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("channel-removed"),
    sequence: NonNegativeInt,
    channelId: ChannelId,
  }),
  // Sent only to subscribers that set `includeCards`. Cards are never deleted, so there is no removal.
  Schema.Struct({
    kind: Schema.Literal("card-upserted"),
    sequence: NonNegativeInt,
    card: OrchestrationCardShell,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({
  /**
   * When provided, the server skips the initial full shell snapshot and instead
   * replays shell events after this sequence before streaming live events.
   * Clients that already hold a cached (or HTTP-loaded) shell snapshot pass its
   * sequence here so the subscription resumes without re-sending the entire
   * projects/threads list (overlapping events are deduped by sequence on the
   * client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * Requests agent and channel shell events. The server sends those kinds only
   * to subscribers that ask, because older clients reject unknown kinds.
   */
  includeAgentChannels: Schema.optionalKey(Schema.Boolean),
  /** Requests card shell events, which older clients would reject. */
  includeCards: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * When provided, the server skips the initial snapshot frame and instead
   * replays events after this sequence before streaming live events. Clients
   * that load the snapshot over HTTP pass the snapshot's sequence here so the
   * live subscription resumes without a gap (overlapping events are deduped by
   * sequence on the client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * When provided, the fallback snapshot frame (sent when `afterSequence` is
   * missing or the catch-up gap is too large) is windowed to the last
   * `turnLimit` user-anchored turns and carries `page` metadata. Absent means
   * the fallback snapshot is the full thread, preserving pre-pagination client
   * behavior. Live events are unaffected either way.
   */
  turnLimit: Schema.optionalKey(PositiveInt),
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

/**
 * Bounds a thread detail read to a window of recent turns. `turnLimit` counts
 * turns with a user pending message (subagent/fan-out turns between them ride
 * along), so the window always contains the last N user prompts. `beforeCursor`
 * requests the disjoint page of older turns strictly before a previously
 * returned cursor. Requests without a window get the full thread; pagination is
 * strictly opt-in so older clients keep today's behavior on both HTTP and the
 * WebSocket fallback snapshot.
 */
export const OrchestrationThreadDetailWindow = Schema.Struct({
  turnLimit: Schema.optionalKey(PositiveInt),
  beforeCursor: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OrchestrationThreadDetailWindow = typeof OrchestrationThreadDetailWindow.Type;

/**
 * Page metadata for a windowed thread detail read. `beforeCursor` is opaque and
 * exclusive: passing it back returns the adjacent disjoint slice of older
 * turns. `null` means the thread is fully loaded below this page. The
 * `snapshotSequence` mirrors the top-level snapshot sequence so history pages
 * can be sequence-checked against live state before merging.
 */
export const OrchestrationThreadDetailPage = Schema.Struct({
  beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
  hasMore: Schema.Boolean,
  snapshotSequence: NonNegativeInt,
  /**
   * Highest event sequence applied to THIS thread at page read time. The
   * global `snapshotSequence` advances with every thread's events, so a
   * client cannot wait for it via its per-thread subscription; this
   * thread-scoped watermark is reachable. A client merging an older page
   * must first have applied live events up to it — otherwise a streaming
   * turn outside the loaded window could have deltas replayed on top of
   * page content that already includes them, duplicating text.
   */
  threadSequence: Schema.optionalKey(NonNegativeInt),
});
export type OrchestrationThreadDetailPage = typeof OrchestrationThreadDetailPage.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  // Present only on windowed responses. Absent on full snapshots (and from
  // pre-pagination servers), which clients treat as fully loaded.
  page: Schema.optional(OrchestrationThreadDetailPage),
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const AgentCreatedPayload = Schema.Struct({
  agentId: AgentId,
  projectId: ProjectId,
  name: AgentName,
  avatar: Schema.NullOr(TrimmedNonEmptyString),
  roleTags: Schema.Array(TrimmedNonEmptyString),
  rolePrompt: Schema.String,
  modelSelection: ModelSelection,
  capabilities: RunCapabilities,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const AgentUpdatedPayload = Schema.Struct({
  agentId: AgentId,
  name: Schema.optional(AgentName),
  avatar: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  roleTags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  rolePrompt: Schema.optional(Schema.String),
  modelSelection: Schema.optional(ModelSelection),
  capabilities: Schema.optional(RunCapabilities),
  updatedAt: IsoDateTime,
});

export const AgentArchivedPayload = Schema.Struct({
  agentId: AgentId,
  archivedAt: IsoDateTime,
});

export const AgentUnarchivedPayload = Schema.Struct({
  agentId: AgentId,
  updatedAt: IsoDateTime,
});

export const CardCreatedPayload = Schema.Struct({
  cardId: CardId,
  // Optional so events from before attempts still decode.
  attemptGroupId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  sourceMessageId: Schema.optional(Schema.NullOr(MessageId)),
  proposalReasoning: Schema.optional(Schema.NullOr(Schema.String)),
  suggestedAgentId: Schema.optional(Schema.NullOr(AgentId)),
  priority: Schema.optional(CardPriority),
  // Optional so cards from before the card contract still decode; absent reads as a legacy card.
  kind: Schema.optional(CardKind),
  acceptance: Schema.optional(CardAcceptance),
  estimate: Schema.optional(Schema.NullOr(CardEstimate)),
  premise: Schema.optional(Schema.NullOr(CardPremise)),
  budgetCapUsd: Schema.optional(Schema.Number),
  projectId: ProjectId,
  channelId: Schema.NullOr(ChannelId),
  parentCardId: Schema.NullOr(CardId),
  title: TrimmedNonEmptyString,
  spec: Schema.String,
  specState: CardSpecState,
  tags: Schema.Array(TrimmedNonEmptyString),
  status: CardStatus,
  ownerHumanId: TrimmedNonEmptyString,
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  createdBy: CardAuthor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const CardUpdatedPayload = Schema.Struct({
  cardId: CardId,
  title: Schema.optional(TrimmedNonEmptyString),
  spec: Schema.optional(Schema.String),
  specState: Schema.optional(CardSpecState),
  tags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  priority: Schema.optional(CardPriority),
  updatedAt: IsoDateTime,
});

export const CardStatusChangedPayload = Schema.Struct({
  cardId: CardId,
  from: CardStatus,
  to: CardStatus,
  move: CardMove,
  // Set when something returned the card to work: failed checks, a review comment, a conflict.
  reason: Schema.optional(TrimmedNonEmptyString),
  // The fix round an automatic return to work used.
  round: Schema.optional(CardFixRound),
  updatedAt: IsoDateTime,
});

export const CardDelegateChangedPayload = Schema.Struct({
  cardId: CardId,
  delegateAgentId: Schema.NullOr(AgentId),
  updatedAt: IsoDateTime,
});

const CardRelationChangeFields = { cardId: CardId, kind: CardRelationKind, otherCardId: CardId };

/** Recorded once on the card that named it; projections also apply the inverse to the other card. */
export const CardRelationAddedPayload = Schema.Struct({
  ...CardRelationChangeFields,
  updatedAt: IsoDateTime,
});

export const CardRelationRemovedPayload = Schema.Struct({
  ...CardRelationChangeFields,
  updatedAt: IsoDateTime,
});

export const CardDecisionRecordedPayload = Schema.Struct({
  cardId: CardId,
  decisionId: TrimmedNonEmptyString,
  author: CardAuthor,
  text: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

export const CardWorkspaceSetPayload = Schema.Struct({
  cardId: CardId,
  branch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  portBase: PositiveInt,
  updatedAt: IsoDateTime,
});

export const CardWorkspaceClearedPayload = Schema.Struct({
  cardId: CardId,
  updatedAt: IsoDateTime,
});

export const CardSessionRequestedPayload = Schema.Struct({
  cardId: CardId,
  agentId: AgentId,
  requestedAt: IsoDateTime,
});

export const CardSessionStartedPayload = CardSession;

export const CardHelperRequestedPayload = Schema.Struct({
  cardId: CardId,
  agentId: AgentId,
  messageId: MessageId,
  question: TrimmedNonEmptyString,
  requestedAt: IsoDateTime,
});

export const CardMessageAuthorKind = Schema.Literals(["human", "agent", "system", "linear"]);
export type CardMessageAuthorKind = typeof CardMessageAuthorKind.Type;

/** A message in a card's activity. `forOwner` messages wait for the owner session's next turn. */
export const CardMessagePostedPayload = Schema.Struct({
  cardId: CardId,
  messageId: MessageId,
  authorKind: CardMessageAuthorKind,
  authorId: TrimmedNonEmptyString,
  body: Schema.String,
  runThreadId: Schema.NullOr(ThreadId),
  forOwner: Schema.Boolean,
  createdAt: IsoDateTime,
});

export const CardDeliveryUpdatedPayload = Schema.Struct({
  cardId: CardId,
  messageIds: Schema.Array(MessageId),
  status: ChannelDeliveryStatus,
  threadId: Schema.NullOr(ThreadId),
  updatedAt: IsoDateTime,
});

export const CardSpecSubmittedPayload = Schema.Struct({
  cardId: CardId,
  agentId: AgentId,
  submittedAt: IsoDateTime,
});

export const CardSnoozedPayload = Schema.Struct({
  cardId: CardId,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: IsoDateTime,
});

export const CardUnsnoozedPayload = Schema.Struct({
  cardId: CardId,
  updatedAt: IsoDateTime,
});

export const CardDiffMeasuredPayload = Schema.Struct({
  cardId: CardId,
  diffStat: CardDiffStat,
  measuredAt: IsoDateTime,
});

export const CardChecksUpdatedPayload = Schema.Struct({
  cardId: CardId,
  checks: CardChecks,
});

export const CardSpendRecordedPayload = Schema.Struct({
  cardId: CardId,
  threadId: ThreadId,
  agentId: AgentId,
  turnId: TurnId,
  costUsd: Schema.Number,
  costSource: UsageCostSource,
  recordedAt: IsoDateTime,
});

export const CardBudgetSetPayload = Schema.Struct({
  cardId: CardId,
  capUsd: Schema.Number,
  updatedAt: IsoDateTime,
});

export const CardLinearSyncedPayload = Schema.Struct({
  cardId: CardId,
  issue: CardLinearIssue,
  syncedAt: IsoDateTime,
});

export const CardUnpricedAcceptedPayload = Schema.Struct({
  cardId: CardId,
  accepts: Schema.Boolean,
  updatedAt: IsoDateTime,
});

/** A plan gate decision and who made it; each also joins the card's decision log. */
export const CardSpecStateChangedPayload = Schema.Struct({
  cardId: CardId,
  from: CardSpecState,
  to: CardSpecState,
  by: CardAuthor,
  updatedAt: IsoDateTime,
});

/** An entry in the card's activity stream, written by a person, an agent's tool or Iskra. */
export const CardActivityRecordedPayload = CardActivity;

export const CardAcceptanceSetPayload = Schema.Struct({
  cardId: CardId,
  acceptance: CardAcceptance,
  updatedAt: IsoDateTime,
});

export const CardPausedPayload = Schema.Struct({
  cardId: CardId,
  ...CardPause.fields,
});

export const CardResumedPayload = Schema.Struct({
  cardId: CardId,
  resumedAt: IsoDateTime,
});

/** Why a card waits, or null once it no longer does. A thread names the session that waits. */
export const CardWaitNotedPayload = Schema.Struct({
  cardId: CardId,
  threadId: Schema.NullOr(ThreadId),
  reason: Schema.NullOr(Reason),
  notedAt: IsoDateTime,
});

export const CardCheckpointRequestedPayload = Schema.Struct({
  cardId: CardId,
  checkpoint: CardCheckpoint,
});

export const CardCheckpointResolvedPayload = Schema.Struct({
  cardId: CardId,
  checkpointId: TrimmedNonEmptyString,
  decision: CardCheckpointDecision,
  note: Schema.NullOr(TrimmedNonEmptyString),
  resolvedAt: IsoDateTime,
});

/** Evidence captured for the card's commit `headSha`; `passed` is decided when it is recorded. */
export const CardEvidenceRecordedPayload = Schema.Struct({
  cardId: CardId,
  evidenceId: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  purpose: CardEvidencePurpose,
  items: Schema.Array(CardEvidenceItem),
  flags: Schema.Array(CardScopeFlag),
  risks: Schema.NullOr(CardRiskClaims),
  passed: Schema.Boolean,
  recordedAt: IsoDateTime,
});

export const CardFlagsAcknowledgedPayload = Schema.Struct({
  cardId: CardId,
  evidenceId: TrimmedNonEmptyString,
  acknowledgedAt: IsoDateTime,
});

export const CardFixRoundsResetPayload = Schema.Struct({
  cardId: CardId,
  resetAt: IsoDateTime,
});

export const CardLandingLinkedPayload = Schema.Struct({
  cardId: CardId,
  landing: CardLanding,
});

export const ChannelCreatedPayload = Schema.Struct({
  channelId: ChannelId,
  projectId: ProjectId,
  kind: ChannelKind,
  name: TrimmedNonEmptyString,
  topic: Schema.String,
  pinnedSpec: Schema.String,
  wakeDepth: NonNegativeInt,
  memberAgentIds: Schema.Array(AgentId),
  leadAgentId: Schema.optional(Schema.NullOr(AgentId)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ChannelUpdatedPayload = Schema.Struct({
  channelId: ChannelId,
  name: Schema.optional(TrimmedNonEmptyString),
  topic: Schema.optional(Schema.String),
  pinnedSpec: Schema.optional(Schema.String),
  wakeDepth: Schema.optional(NonNegativeInt),
  memberAgentIds: Schema.optional(Schema.Array(AgentId)),
  leadAgentId: Schema.optional(Schema.NullOr(AgentId)),
  updatedAt: IsoDateTime,
});

export const ChannelArchivedPayload = Schema.Struct({
  channelId: ChannelId,
  archivedAt: IsoDateTime,
});

export const ChannelUnarchivedPayload = Schema.Struct({
  channelId: ChannelId,
  updatedAt: IsoDateTime,
});

export const ChannelMessagePostedPayload = Schema.Struct({
  channelId: ChannelId,
  messageId: MessageId,
  authorKind: ChannelMessageAuthorKind,
  authorId: TrimmedNonEmptyString,
  body: Schema.String,
  createdAt: IsoDateTime,
  runThreadId: Schema.optional(ThreadId),
  // The project agents a human message named, resolved when it was posted.
  mentions: Schema.optional(Schema.Array(AgentId)),
  // A lead's question with options to pick from.
  elicitation: Schema.optional(Elicitation),
  // The lead question a person's message answers.
  answers: Schema.optional(ElicitationAnswer),
});

export const ChannelAgentWakeRequestedPayload = Schema.Struct({
  channelId: ChannelId,
  agentId: AgentId,
  triggerMessageId: MessageId,
  requestedAt: IsoDateTime,
  // Set when the agent is already live in this channel: the message joins that run.
  liveRunThreadId: Schema.optional(ThreadId),
  // Set on a DM to an agent busy in another channel: no run starts until that conversation ends.
  queued: Schema.optional(Schema.Boolean),
});

export const ChannelRunStartedPayload = ChannelRun;

export const ChannelDeliveryUpdatedPayload = Schema.Struct({
  channelId: ChannelId,
  agentId: AgentId,
  messageIds: Schema.Array(MessageId),
  status: ChannelDeliveryStatus,
  runThreadId: Schema.NullOr(ThreadId),
  updatedAt: IsoDateTime,
});

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  // Retained for older clients that sent an automatic create-time seed. The
  // server ignores it; explicit project defaults use project.meta.update.
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  // Absent = leave unchanged; null = clear the override.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  autoPull: Schema.optional(Schema.Boolean),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

/** A person replacing the project's whole orchestration policy; no tool or reactor sends it. */
const ProjectOrchestrationSetCommand = Schema.Struct({
  type: Schema.Literal("project.orchestration.set"),
  commandId: CommandId,
  projectId: ProjectId,
  orchestration: ProjectOrchestration,
});

const AgentCreateCommand = Schema.Struct({
  type: Schema.Literal("agent.create"),
  commandId: CommandId,
  agentId: AgentId,
  projectId: ProjectId,
  name: AgentName,
  avatar: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  roleTags: Schema.Array(TrimmedNonEmptyString),
  rolePrompt: Schema.String,
  modelSelection: ModelSelection,
  capabilities: RunCapabilities,
  createdAt: IsoDateTime,
});

const AgentUpdateCommand = Schema.Struct({
  type: Schema.Literal("agent.update"),
  commandId: CommandId,
  ...Struct.omit(AgentUpdatedPayload.fields, ["updatedAt"]),
});

const AgentArchiveCommand = Schema.Struct({
  type: Schema.Literal("agent.archive"),
  commandId: CommandId,
  agentId: AgentId,
});

const AgentUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("agent.unarchive"),
  commandId: CommandId,
  agentId: AgentId,
});

const CardCreateCommand = Schema.Struct({
  type: Schema.Literal("card.create"),
  commandId: CommandId,
  cardId: CardId,
  projectId: ProjectId,
  channelId: Schema.optional(Schema.NullOr(ChannelId)),
  parentCardId: Schema.optional(Schema.NullOr(CardId)),
  title: TrimmedNonEmptyString,
  spec: Schema.String,
  tags: Schema.Array(TrimmedNonEmptyString),
  baseBranch: Schema.optional(TrimmedNonEmptyString),
  // Draft acceptance criteria; approving the card confirms them.
  criteria: Schema.optional(Schema.Array(CardCriterion)),
  createdAt: IsoDateTime,
});

const CardUpdateCommand = Schema.Struct({
  type: Schema.Literal("card.update"),
  commandId: CommandId,
  ...Struct.omit(CardUpdatedPayload.fields, ["specState", "updatedAt"]),
});

/** A status command names only the card: the decider derives where it goes. */
const cardStatusCommand = <const Type extends string>(type: Type) =>
  Schema.Struct({
    type: Schema.Literal(type),
    commandId: CommandId,
    cardId: CardId,
  });

const CardApproveCommand = Schema.Struct({
  ...cardStatusCommand("card.approve").fields,
  // Approve & start: also approves a draft spec and assigns this agent, so its owner session starts.
  delegateAgentId: Schema.optional(AgentId),
  // The acceptance criteria the person confirms by approving; absent confirms the card's own.
  criteria: Schema.optional(Schema.Array(CardCriterion)),
});

/** A person writing the card's acceptance criteria: a draft in triage, confirmed once approved. */
const CardCriteriaSetCommand = Schema.Struct({
  type: Schema.Literal("card.criteria.set"),
  commandId: CommandId,
  cardId: CardId,
  criteria: Schema.Array(CardCriterion),
});
const CardCriteriaConfirmCommand = cardStatusCommand("card.criteria.confirm");

/** A person answering the owner's checkpoint: go on, go on differently, or stop and pause. */
const CardCheckpointResolveCommand = Schema.Struct({
  type: Schema.Literal("card.checkpoint.resolve"),
  commandId: CommandId,
  cardId: CardId,
  decision: CardCheckpointDecision,
  note: Schema.optional(TrimmedNonEmptyString),
});

/** A person answering an open question on a card with an offered option or their own words. */
const CardElicitationAnswerCommand = Schema.Struct({
  type: Schema.Literal("card.elicitation.answer"),
  commandId: CommandId,
  cardId: CardId,
  // The question's activity: an owner's question, a checkpoint or a proposed criteria change.
  activityId: TrimmedNonEmptyString,
  optionId: Schema.NullOr(TrimmedNonEmptyString),
  body: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

/** A person accepting the hard scope flags on the card's latest evidence, so its merge can be approved. */
const CardFlagsAcknowledgeCommand = Schema.Struct({
  type: Schema.Literal("card.flags.acknowledge"),
  commandId: CommandId,
  cardId: CardId,
  evidenceId: TrimmedNonEmptyString,
});

/** A person giving the card its fix rounds again. */
const CardFixRoundsResetCommand = cardStatusCommand("card.fix-rounds.reset");
const CardPauseCommand = cardStatusCommand("card.pause");
const CardResumeCommand = cardStatusCommand("card.resume");
const CardUnapproveCommand = cardStatusCommand("card.unapprove");
const CardMergeApproveCommand = cardStatusCommand("card.merge.approve");
const CardMergeCancelCommand = cardStatusCommand("card.merge.cancel");
const CardAbandonCommand = cardStatusCommand("card.abandon");
const CardReopenCommand = cardStatusCommand("card.reopen");
const CardUnassignCommand = cardStatusCommand("card.unassign");

const CardAssignCommand = Schema.Struct({
  type: Schema.Literal("card.assign"),
  commandId: CommandId,
  cardId: CardId,
  agentId: AgentId,
});

const CardRelationAddCommand = Schema.Struct({
  type: Schema.Literal("card.relation.add"),
  commandId: CommandId,
  ...CardRelationChangeFields,
});

const CardRelationRemoveCommand = Schema.Struct({
  type: Schema.Literal("card.relation.remove"),
  commandId: CommandId,
  ...CardRelationChangeFields,
});

const CardDecisionRecordCommand = Schema.Struct({
  type: Schema.Literal("card.decision.record"),
  commandId: CommandId,
  cardId: CardId,
  decisionId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

// Server-only: dispatched by the session reactor, agent tools, checks and the merge queue.
const CardWorkStartCommand = cardStatusCommand("card.work.start");
const CardLandCommand = Schema.Struct({
  ...cardStatusCommand("card.land").fields,
  // The merged pull request, when a person merged it on the host rather than through Iskra.
  mergedOnHostUrl: Schema.optional(TrimmedNonEmptyString),
});

const CardWorkReturnCommand = Schema.Struct({
  type: Schema.Literal("card.work.return"),
  commandId: CommandId,
  cardId: CardId,
  reason: TrimmedNonEmptyString,
  // An automatic return uses a fix round, refused once the project's rounds are used up.
  round: Schema.optional(CardFixRound),
});

// Server-only: the card contract's reactor and tool commands.
const CardActivityRecordCommand = Schema.Struct({
  type: Schema.Literal("card.activity.record"),
  commandId: CommandId,
  ...Struct.omit(CardActivity.fields, ["delivery"]),
});

const CardCheckpointRequestCommand = Schema.Struct({
  type: Schema.Literal("card.checkpoint.request"),
  commandId: CommandId,
  cardId: CardId,
  checkpoint: CardCheckpoint,
});

/** Evidence the server captured; the decider decides whether it passed. */
const CardEvidenceRecordCommand = Schema.Struct({
  type: Schema.Literal("card.evidence.record"),
  commandId: CommandId,
  ...Struct.omit(CardEvidenceRecordedPayload.fields, ["passed"]),
});

/** Moves a card into review, refused without passing evidence for the commit `headSha`. */
const CardReviewEnterCommand = Schema.Struct({
  type: Schema.Literal("card.review.enter"),
  commandId: CommandId,
  cardId: CardId,
  headSha: TrimmedNonEmptyString,
});

/** Lands a card with no person's merge approval: a plan child, or a project with auto-merge on. */
const CardLandingBeginCommand = Schema.Struct({
  type: Schema.Literal("card.landing.begin"),
  commandId: CommandId,
  cardId: CardId,
  reason: CardLandingBeginReason,
});

const CardLandingLinkCommand = Schema.Struct({
  type: Schema.Literal("card.landing.link"),
  commandId: CommandId,
  ...CardLandingLinkedPayload.fields,
});

const CardWaitNoteCommand = Schema.Struct({
  type: Schema.Literal("card.wait.note"),
  commandId: CommandId,
  ...CardWaitNotedPayload.fields,
});

/** Iskra pausing a card itself, such as after repeated failed restarts. */
const CardPauseSystemCommand = Schema.Struct({
  type: Schema.Literal("card.pause.system"),
  commandId: CommandId,
  cardId: CardId,
  reason: Reason,
});

const CardWorkspaceSetCommand = Schema.Struct({
  type: Schema.Literal("card.workspace.set"),
  commandId: CommandId,
  ...Struct.omit(CardWorkspaceSetPayload.fields, ["updatedAt"]),
});

const CardWorkspaceClearCommand = cardStatusCommand("card.workspace.clear");

/** Plan gate decisions. Each names only the card: the decider derives where the spec goes. */
const CardSpecApproveCommand = cardStatusCommand("card.spec.approve");
const CardSpecSkipCommand = cardStatusCommand("card.spec.skip");
const CardSpecReopenCommand = cardStatusCommand("card.spec.reopen");

/** Sends a draft spec to a read-only critic: the card's agent, unless another is named. */
const CardSpecSubmitCommand = Schema.Struct({
  type: Schema.Literal("card.spec.submit"),
  commandId: CommandId,
  cardId: CardId,
  agentId: Schema.optional(AgentId),
});

/** Hides a card from Needs you until a time, or with no time until its next activity. */
const CardSnoozeCommand = Schema.Struct({
  type: Schema.Literal("card.snooze"),
  commandId: CommandId,
  cardId: CardId,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
const CardUnsnoozeCommand = cardStatusCommand("card.unsnooze");

// Server-only: the card session reactor records the diff size after an owner turn.
const CardDiffRecordCommand = Schema.Struct({
  type: Schema.Literal("card.diff.record"),
  commandId: CommandId,
  ...CardDiffMeasuredPayload.fields,
});

// Server-only: the review reactor records check runs, and flags overlaps when a card lands.
const CardChecksRecordCommand = Schema.Struct({
  type: Schema.Literal("card.checks.record"),
  commandId: CommandId,
  cardId: CardId,
  state: CardChecks.fields.state,
  summary: Schema.String,
  updatedAt: IsoDateTime,
});

const CardOverlapFlagCommand = Schema.Struct({
  type: Schema.Literal("card.overlap.flag"),
  commandId: CommandId,
  cardId: CardId,
  otherCardId: CardId,
});

/** A person trying a ready card with several agents at once; each attempt is a sub-card on its own branch. */
const CardAttemptsStartCommand = Schema.Struct({
  type: Schema.Literal("card.attempts.start"),
  commandId: CommandId,
  cardId: CardId,
  attempts: Schema.Array(Schema.Struct({ cardId: CardId, agentId: AgentId })),
  createdAt: IsoDateTime,
});

/** Makes one attempt's branch the card's branch and drops the other attempts (invariant 16). */
const CardAttemptPromoteCommand = cardStatusCommand("card.attempt.promote");

/** A person's cap on what a card may spend; setting it above the spend lets turns start again. */
const CardBudgetSetCommand = Schema.Struct({
  type: Schema.Literal("card.budget.set"),
  commandId: CommandId,
  ...Struct.omit(CardBudgetSetPayload.fields, ["updatedAt"]),
});

/** A person accepting, or taking back, running a card's unpriced model without a cap. */
const CardUnpricedAcceptCommand = cardStatusCommand("card.unpriced.accept");
const CardUnpricedRefuseCommand = cardStatusCommand("card.unpriced.refuse");

// Server-only: Linear sync. An issue becomes a card in triage; delegating it in Linear is a
// person's approval.
const CardLinearIntakeCommand = Schema.Struct({
  type: Schema.Literal("card.linear.intake"),
  commandId: CommandId,
  cardId: CardId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  issue: CardLinearIssue,
  delegated: Schema.Boolean,
  createdAt: IsoDateTime,
});

const CardLinearSyncCommand = Schema.Struct({
  type: Schema.Literal("card.linear.sync"),
  commandId: CommandId,
  ...CardLinearSyncedPayload.fields,
});

// Server-only: what agents do through board tools. Tools never approve, assign or land.
const CardProposeCommand = Schema.Struct({
  type: Schema.Literal("card.propose"),
  commandId: CommandId,
  cardId: CardId,
  agentId: AgentId,
  projectId: ProjectId,
  channelId: Schema.optional(Schema.NullOr(ChannelId)),
  parentCardId: Schema.optional(Schema.NullOr(CardId)),
  title: TrimmedNonEmptyString,
  spec: Schema.String,
  tags: Schema.Array(TrimmedNonEmptyString),
  // Set when a channel's lead proposes the card from a message.
  lead: Schema.optional(
    Schema.Struct({
      sourceMessageId: MessageId,
      reasoning: TrimmedNonEmptyString,
      likelyDuplicateCardIds: Schema.Array(CardId),
      // A project agent's name; an unknown or archived one is dropped, not refused.
      suggestedAgentName: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  criteria: Schema.optional(Schema.Array(CardCriterion)),
  estimate: Schema.optional(CardEstimate),
  premise: Schema.optional(CardPremise),
  // A builder's sub-card of its own card: ready at once, on the parent's budget and spec approval.
  subCard: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

// Server-only: the spend reactor records each priced turn of a card's sessions.
const CardSpendRecordCommand = Schema.Struct({
  type: Schema.Literal("card.spend.record"),
  commandId: CommandId,
  ...CardSpendRecordedPayload.fields,
});

/** A person's review comment: it goes to the card's agent, and a card in review goes back to work. */
const CardReviewCommentCommand = Schema.Struct({
  type: Schema.Literal("card.review.comment"),
  commandId: CommandId,
  cardId: CardId,
  messageId: MessageId,
  body: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

/** Starts a fresh owner session for the card's agent, as after a lost or stopped one. */
const CardSessionStartCommand = Schema.Struct({
  type: Schema.Literal("card.session.start"),
  commandId: CommandId,
  cardId: CardId,
  createdAt: IsoDateTime,
});

/** Asks an agent a question about a card in a read-only session; the answer goes to the owner. */
const CardHelperRequestCommand = Schema.Struct({
  type: Schema.Literal("card.helper.request"),
  commandId: CommandId,
  cardId: CardId,
  agentId: AgentId,
  messageId: MessageId,
  question: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

/** A person's message for the card's owner session, delivered as its next turn. */
const CardMessagePostCommand = Schema.Struct({
  type: Schema.Literal("card.message.post"),
  commandId: CommandId,
  cardId: CardId,
  messageId: MessageId,
  body: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

/**
 * A message from an agent's DM into one of its live sessions. It follows that
 * session's delivery rules and never starts a session.
 */
const AgentSessionMessageCommand = Schema.Struct({
  type: Schema.Literal("agent.session.message"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  body: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

/**
 * A person's direct message to an agent. It posts in the agent's DM channel,
 * opening one on the first message, and wakes the agent there.
 */
const AgentDmPostCommand = Schema.Struct({
  type: Schema.Literal("agent.dm.post"),
  commandId: CommandId,
  agentId: AgentId,
  messageId: MessageId,
  body: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

// Server-only: the card session reactor records sessions, replies and deliveries.
const CardSessionRecordCommand = Schema.Struct({
  type: Schema.Literal("card.session.record"),
  commandId: CommandId,
  ...CardSession.fields,
});

const CardDeliveryUpdateCommand = Schema.Struct({
  type: Schema.Literal("card.delivery.update"),
  commandId: CommandId,
  ...CardDeliveryUpdatedPayload.fields,
});

const ChannelCreateCommand = Schema.Struct({
  type: Schema.Literal("channel.create"),
  commandId: CommandId,
  channelId: ChannelId,
  projectId: ProjectId,
  kind: ChannelKind,
  name: TrimmedNonEmptyString,
  topic: Schema.optional(Schema.String),
  pinnedSpec: Schema.optional(Schema.String),
  wakeDepth: Schema.optional(NonNegativeInt),
  memberAgentIds: Schema.Array(AgentId),
  leadAgentId: Schema.optional(Schema.NullOr(AgentId)),
  createdAt: IsoDateTime,
});

const ChannelUpdateCommand = Schema.Struct({
  type: Schema.Literal("channel.update"),
  commandId: CommandId,
  ...Struct.omit(ChannelUpdatedPayload.fields, ["updatedAt"]),
});

const ChannelArchiveCommand = Schema.Struct({
  type: Schema.Literal("channel.archive"),
  commandId: CommandId,
  channelId: ChannelId,
});

const ChannelUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("channel.unarchive"),
  commandId: CommandId,
  channelId: ChannelId,
});

const ChannelMessagePostCommand = Schema.Struct({
  type: Schema.Literal("channel.message.post"),
  commandId: CommandId,
  channelId: ChannelId,
  messageId: MessageId,
  body: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const ChannelAgentWakeCommand = Schema.Struct({
  type: Schema.Literal("channel.agent.wake"),
  commandId: CommandId,
  channelId: ChannelId,
  agentId: AgentId,
  triggerMessageId: MessageId,
  createdAt: IsoDateTime,
});

const ChannelRunStartCommand = Schema.Struct({
  type: Schema.Literal("channel.run.start"),
  commandId: CommandId,
  ...ChannelRun.fields,
});

const ChannelMessageAgentPostCommand = Schema.Struct({
  type: Schema.Literal("channel.message.agent.post"),
  commandId: CommandId,
  channelId: ChannelId,
  messageId: MessageId,
  agentId: AgentId,
  runThreadId: ThreadId,
  body: Schema.String,
  // A lead's question with options for a person to pick from.
  elicitation: Schema.optional(Elicitation),
  createdAt: IsoDateTime,
});

/** A person answering a lead's question, with an offered option or their own words. */
const ChannelElicitationAnswerCommand = Schema.Struct({
  type: Schema.Literal("channel.elicitation.answer"),
  commandId: CommandId,
  channelId: ChannelId,
  questionMessageId: MessageId,
  messageId: MessageId,
  optionId: Schema.NullOr(TrimmedNonEmptyString),
  body: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

// Server-only: a note Iskra posts in a channel, such as a card's progress. It wakes no one.
const ChannelMessageSystemPostCommand = Schema.Struct({
  type: Schema.Literal("channel.message.system.post"),
  commandId: CommandId,
  channelId: ChannelId,
  messageId: MessageId,
  body: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const ChannelDeliveryUpdateCommand = Schema.Struct({
  type: Schema.Literal("channel.delivery.update"),
  commandId: CommandId,
  ...ChannelDeliveryUpdatedPayload.fields,
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  historyImport: Schema.optional(Schema.Literal(true)),
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadAutoSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.auto-settle"),
  commandId: CommandId,
  threadId: ThreadId,
  snapshotSequence: NonNegativeInt,
  settledAt: IsoDateTime,
});

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity un-settles are decided server-side
  // (the decider emits thread.unsettled(reason: "activity") events directly,
  // never through this command), so a client cannot forge the neutral reset.
  reason: Schema.Literal("user"),
});

const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // The wake time. Event-based wake conditions (PR merged, review posted)
  // will arrive as an optional condition field alongside this; time-based
  // snooze is just the first kind of condition.
  snoozedUntil: IsoDateTime,
});

const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity wakes are decided server-side (the
  // decider emits thread.unsnoozed(reason: "activity") directly), and timer
  // wakes need no event at all — clients derive visibility from snoozedUntil,
  // so a passed wake time simply stops classifying as snoozed.
  reason: Schema.Literal("user"),
});

const ThreadPinCommand = Schema.Struct({
  type: Schema.Literal("thread.pin"),
  commandId: CommandId,
  threadId: ThreadId,
  // Initial slot in the user-arranged pinned order (see ThreadPinReorderCommand).
  // Optional: clients on pre-reorder servers omit it, and the pinned block
  // falls back to creation order for keyless threads.
  orderKey: Schema.optional(TrimmedNonEmptyString),
});

const ThreadUnpinCommand = Schema.Struct({
  type: Schema.Literal("thread.unpin"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadPinReorderCommand = Schema.Struct({
  type: Schema.Literal("thread.pin.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  // Fractional index key: pinned threads sort by plain string comparison of
  // these keys, so a drag writes one key to one thread — neighbors (possibly
  // on other servers) are never touched. Clients compute a key that sorts
  // between the dropped position's neighbors.
  orderKey: TrimmedNonEmptyString,
});

const ThreadActiveReorderCommand = Schema.Struct({
  type: Schema.Literal("thread.active.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.title !== undefined && input.regenerateTitle === true) ||
      "title and regenerateTitle cannot be specified together",
  ),
);

const ThreadPullRequestLinkCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request.link"),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
});

const ThreadPullRequestUnlinkCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request.unlink"),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    context: Schema.optional(OrchestrationMessageContext),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(Schema.Union([UploadChatAttachment, ChatAttachment])),
    context: Schema.optional(OrchestrationMessageContext),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: Schema.optional(UserInputAttachments),
  createdAt: IsoDateTime,
});

// Closes an async question without answering it. The agent is not messaged;
// the composer is simply released. Native callback questions cannot be dismissed
// this way because the provider is blocked waiting on a reply.
const ThreadUserInputDismissCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.dismiss"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

// A separate command makes older servers reject history-only rewinds rather than
// ignoring an unfamiliar option and restoring files.
const ThreadConversationRevertCommand = Schema.Struct({
  ...ThreadCheckpointRevertCommand.fields,
  type: Schema.Literal("thread.conversation.revert"),
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  // Settle-cleanup stops are conditional: the decider drops the stop if the
  // thread was re-engaged (unsettled, session starting/running, or a queued
  // turn start) between the settle and this command. Guarding in the decider
  // closes the race a post-settle snapshot read cannot: commands are decided
  // serially against the authoritative read model.
  onlyIfSettled: Schema.optional(Schema.Boolean),
});

/** Agent, card and channel commands a client may send, shared by both client command unions. */
const IskraClientCommands = [
  AgentCreateCommand,
  AgentUpdateCommand,
  AgentArchiveCommand,
  AgentUnarchiveCommand,
  AgentSessionMessageCommand,
  AgentDmPostCommand,
  CardCreateCommand,
  CardUpdateCommand,
  CardApproveCommand,
  CardUnapproveCommand,
  CardAssignCommand,
  CardUnassignCommand,
  CardMergeApproveCommand,
  CardMergeCancelCommand,
  CardAbandonCommand,
  CardReopenCommand,
  CardRelationAddCommand,
  CardRelationRemoveCommand,
  CardDecisionRecordCommand,
  CardSessionStartCommand,
  CardHelperRequestCommand,
  CardMessagePostCommand,
  CardSpecApproveCommand,
  CardSpecSkipCommand,
  CardSpecReopenCommand,
  CardSpecSubmitCommand,
  CardSnoozeCommand,
  CardUnsnoozeCommand,
  CardReviewCommentCommand,
  CardBudgetSetCommand,
  CardUnpricedAcceptCommand,
  CardUnpricedRefuseCommand,
  CardAttemptsStartCommand,
  CardAttemptPromoteCommand,
  CardCriteriaSetCommand,
  CardCriteriaConfirmCommand,
  CardCheckpointResolveCommand,
  CardElicitationAnswerCommand,
  CardFlagsAcknowledgeCommand,
  CardFixRoundsResetCommand,
  CardPauseCommand,
  CardResumeCommand,
  ChannelCreateCommand,
  ChannelUpdateCommand,
  ChannelArchiveCommand,
  ChannelUnarchiveCommand,
  ChannelMessagePostCommand,
  ChannelElicitationAnswerCommand,
  ProjectOrchestrationSetCommand,
] as const;

const DispatchableClientOrchestrationCommand = Schema.Union([
  ...IskraClientCommands,
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadActiveReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadPullRequestLinkCommand,
  ThreadPullRequestUnlinkCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadUserInputDismissCommand,
  ThreadCheckpointRevertCommand,
  ThreadConversationRevertCommand,
  ThreadSessionStopCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ...IskraClientCommands,
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadActiveReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadPullRequestLinkCommand,
  ThreadPullRequestUnlinkCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadUserInputDismissCommand,
  ThreadCheckpointRevertCommand,
  ThreadConversationRevertCommand,
  ThreadSessionStopCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadHistoryImportCommand = Schema.Struct({
  type: Schema.Literal("thread.history.import"),
  commandId: CommandId,
  threadId: ThreadId,
  messages: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: IsoDateTime,
    }),
  ).check(Schema.isNonEmpty()),
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadTitleRegenerationCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.title.regeneration.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  title: Schema.optional(TrimmedNonEmptyString),
});

const ThreadPullRequestSyncCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request.sync"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  snapshotSequence: NonNegativeInt,
  expected: Schema.Struct({
    workspaceRoot: TrimmedNonEmptyString,
    branch: Schema.NullOr(TrimmedNonEmptyString),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
    linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
    branchPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  }),
  branchPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  linkedPullRequest: Schema.optional(ThreadLinkedPullRequest),
});

const ThreadPullRequestLinkSyncCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request-link.sync"),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
  snapshot: ThreadPullRequestSnapshot,
  stack: Schema.NullOr(ThreadPullRequestStack),
});

const InternalOrchestrationCommand = Schema.Union([
  CardActivityRecordCommand,
  CardCheckpointRequestCommand,
  CardEvidenceRecordCommand,
  CardReviewEnterCommand,
  CardLandingBeginCommand,
  CardLandingLinkCommand,
  CardWaitNoteCommand,
  CardPauseSystemCommand,
  CardWorkStartCommand,
  CardWorkReturnCommand,
  CardLandCommand,
  CardWorkspaceSetCommand,
  CardWorkspaceClearCommand,
  CardSessionRecordCommand,
  CardDeliveryUpdateCommand,
  CardDiffRecordCommand,
  CardChecksRecordCommand,
  CardOverlapFlagCommand,
  CardSpendRecordCommand,
  CardProposeCommand,
  CardLinearIntakeCommand,
  CardLinearSyncCommand,
  ChannelAgentWakeCommand,
  ChannelRunStartCommand,
  ChannelMessageAgentPostCommand,
  ChannelMessageSystemPostCommand,
  ChannelDeliveryUpdateCommand,
  ThreadAutoSettleCommand,
  ThreadPullRequestSyncCommand,
  ThreadPullRequestLinkSyncCommand,
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadHistoryImportCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
  ThreadTitleRegenerationCompleteCommand,
  ThreadPullRequestSyncCommand,
  ThreadPullRequestLinkSyncCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "agent.created",
  "agent.updated",
  "agent.archived",
  "agent.unarchived",
  "card.created",
  "card.updated",
  "card.status-changed",
  "card.delegate-changed",
  "card.relation-added",
  "card.relation-removed",
  "card.decision-recorded",
  "card.workspace-set",
  "card.workspace-cleared",
  "card.session-requested",
  "card.session-started",
  "card.helper-requested",
  "card.message-posted",
  "card.delivery-updated",
  "card.spec-submitted",
  "card.spec-state-changed",
  "card.snoozed",
  "card.unsnoozed",
  "card.diff-measured",
  "card.checks-updated",
  "card.spend-recorded",
  "card.budget-set",
  "card.unpriced-accepted",
  "card.linear-synced",
  "card.activity-recorded",
  "card.acceptance-set",
  "card.paused",
  "card.resumed",
  "card.wait-noted",
  "card.checkpoint-requested",
  "card.checkpoint-resolved",
  "card.evidence-recorded",
  "card.flags-acknowledged",
  "card.fix-rounds-reset",
  "card.landing-linked",
  "project.orchestration-set",
  "channel.created",
  "channel.updated",
  "channel.archived",
  "channel.unarchived",
  "channel.message-posted",
  "channel.agent-wake-requested",
  "channel.run-started",
  "channel.delivery-updated",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.meta-updated",
  "thread.pull-request-linked",
  "thread.pull-request-unlinked",
  "thread.pull-request-synced",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals([
  "project",
  "thread",
  "agent",
  "channel",
  "card",
]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // Optional so persisted events from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  autoPull: Schema.optional(Schema.Boolean),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

/** A person replacing the project's whole orchestration policy. */
export const ProjectOrchestrationSetPayload = Schema.Struct({
  projectId: ProjectId,
  orchestration: ProjectOrchestration,
  updatedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  // user: explicit "wake now". activity: real work arrived (user message /
  // session coming alive) and the decider cleared the snooze — mirrors
  // thread.unsettled's activity resets. Timer wakes emit no event: clients
  // derive them from snoozedUntil passing.
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadPinnedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedAt: IsoDateTime,
  // Absent on re-pins of an already-pinned thread (the existing key wins)
  // and on pins from clients that predate reordering.
  pinOrderKey: Schema.optional(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ThreadUnpinnedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadPinReorderedPayload = Schema.Struct({
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  // Order updates use this existing event so older clients can ignore the
  // new field while continuing to decode the event stream.
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  title: Schema.optional(TrimmedNonEmptyString),
  /** Intent marker consumed by the title-generation reactor. Keeping this on
      the existing event lets older clients safely ignore the new field. */
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  /** Title at request time, used to avoid overwriting a later manual rename. */
  previousTitle: Schema.optional(TrimmedNonEmptyString),
  /** Pending state shared with clients. Null clears a matching request. */
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // No longer produced; kept so persisted events from before
  // thread.pull-request-linked still decode and replay into the link table.
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  updatedAt: IsoDateTime,
});

export const ThreadPullRequestLinkedPayload = Schema.Struct({
  threadId: ThreadId,
  link: ThreadPullRequestLink,
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestLinkedPayload = typeof ThreadPullRequestLinkedPayload.Type;

export const ThreadPullRequestUnlinkedPayload = Schema.Struct({
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestUnlinkedPayload = typeof ThreadPullRequestUnlinkedPayload.Type;

export const ThreadPullRequestSyncedPayload = Schema.Struct({
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
  snapshot: ThreadPullRequestSnapshot,
  stack: Schema.NullOr(ThreadPullRequestStack),
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestSyncedPayload = typeof ThreadPullRequestSyncedPayload.Type;

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  context: Schema.optional(OrchestrationMessageContext),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: Schema.optional(UserInputAttachments),
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  restoreFiles: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

/**
 * Which client connection dispatched the command that produced an event.
 * Stamped by the orchestration engine on client-dispatched commands; absent on
 * provider/server-originated events and on commands from clients too old to
 * report it.
 */
export const OrchestrationClientOrigin = Schema.Struct({
  surface: Schema.optional(ClientSurface),
  appVersion: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationClientOrigin = typeof OrchestrationClientOrigin.Type;

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
  historyImport: Schema.optional(Schema.Boolean),
  origin: Schema.optional(OrchestrationClientOrigin),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, AgentId, ChannelId, CardId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("agent.created"),
    payload: AgentCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("agent.updated"),
    payload: AgentUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("agent.archived"),
    payload: AgentArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("agent.unarchived"),
    payload: AgentUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.created"),
    payload: CardCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.updated"),
    payload: CardUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.status-changed"),
    payload: CardStatusChangedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.delegate-changed"),
    payload: CardDelegateChangedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.relation-added"),
    payload: CardRelationAddedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.relation-removed"),
    payload: CardRelationRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.decision-recorded"),
    payload: CardDecisionRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.workspace-set"),
    payload: CardWorkspaceSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.workspace-cleared"),
    payload: CardWorkspaceClearedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.session-requested"),
    payload: CardSessionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.session-started"),
    payload: CardSessionStartedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.helper-requested"),
    payload: CardHelperRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.message-posted"),
    payload: CardMessagePostedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.delivery-updated"),
    payload: CardDeliveryUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.spec-submitted"),
    payload: CardSpecSubmittedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.spec-state-changed"),
    payload: CardSpecStateChangedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.snoozed"),
    payload: CardSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.unsnoozed"),
    payload: CardUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.diff-measured"),
    payload: CardDiffMeasuredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.checks-updated"),
    payload: CardChecksUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.spend-recorded"),
    payload: CardSpendRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.budget-set"),
    payload: CardBudgetSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.linear-synced"),
    payload: CardLinearSyncedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.unpriced-accepted"),
    payload: CardUnpricedAcceptedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.activity-recorded"),
    payload: CardActivityRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.acceptance-set"),
    payload: CardAcceptanceSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.paused"),
    payload: CardPausedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.resumed"),
    payload: CardResumedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.wait-noted"),
    payload: CardWaitNotedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.checkpoint-requested"),
    payload: CardCheckpointRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.checkpoint-resolved"),
    payload: CardCheckpointResolvedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.evidence-recorded"),
    payload: CardEvidenceRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.flags-acknowledged"),
    payload: CardFlagsAcknowledgedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.fix-rounds-reset"),
    payload: CardFixRoundsResetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("card.landing-linked"),
    payload: CardLandingLinkedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.orchestration-set"),
    payload: ProjectOrchestrationSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("channel.created"),
    payload: ChannelCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("channel.updated"),
    payload: ChannelUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("channel.archived"),
    payload: ChannelArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("channel.unarchived"),
    payload: ChannelUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("channel.message-posted"),
    payload: ChannelMessagePostedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("channel.agent-wake-requested"),
    payload: ChannelAgentWakeRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("channel.run-started"),
    payload: ChannelRunStartedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("channel.delivery-updated"),
    payload: ChannelDeliveryUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned"),
    payload: ThreadPinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unpinned"),
    payload: ThreadUnpinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pin-reordered"),
    payload: ThreadPinReorderedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pull-request-linked"),
    payload: ThreadPullRequestLinkedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pull-request-unlinked"),
    payload: ThreadPullRequestUnlinkedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pull-request-synced"),
    payload: ThreadPullRequestSyncedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue({
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export const OrchestrationGetWorkflowScriptInput = Schema.Struct({
  threadId: ThreadId,
  /** Absolute path from the workflow's runHandles.scriptPath. The server
   * re-derives containment; the client value is a hint, never trusted. */
  scriptPath: TrimmedNonEmptyString,
});
export type OrchestrationGetWorkflowScriptInput = typeof OrchestrationGetWorkflowScriptInput.Type;

export const OrchestrationGetWorkflowScriptResult = Schema.Struct({
  scriptPath: TrimmedNonEmptyString,
  contents: Schema.String,
  truncated: Schema.Boolean,
});
export type OrchestrationGetWorkflowScriptResult = typeof OrchestrationGetWorkflowScriptResult.Type;

const WORKFLOW_SCRIPT_ERROR_MESSAGES = {
  "invalid-path": "Workflow scripts must be absolute .js paths.",
  "root-unavailable": "Script root unavailable.",
  "not-found": "Script not found.",
  "outside-root": "Script path is outside the workflow scripts root.",
  "not-js": "Resolved script is not a .js file.",
  "not-regular-file": "Script is not a regular file.",
  "changed-during-read": "Script changed between resolution and open.",
  "read-failed": "Script read failed.",
} as const;

export class OrchestrationGetWorkflowScriptError extends Schema.TaggedError<OrchestrationGetWorkflowScriptError>()(
  "OrchestrationGetWorkflowScriptError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "not-js",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    scriptPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKFLOW_SCRIPT_ERROR_MESSAGES[this.reason];
  }
}

/** How many of an agent's newest sessions its DM shows. */
export const AGENT_RUNS_LIMIT = 20;

/** A run with when it ended; `endedAt` is null while the run is live. */
export const OrchestrationAgentRun = Schema.Struct({
  ...OrchestrationRun.fields,
  endedAt: Schema.NullOr(IsoDateTime),
  // The card a card session works on, to label it.
  cardTitle: Schema.NullOr(TrimmedNonEmptyString),
});
export type OrchestrationAgentRun = typeof OrchestrationAgentRun.Type;

export const OrchestrationListAgentRunsInput = Schema.Struct({
  agentId: AgentId,
});
export type OrchestrationListAgentRunsInput = typeof OrchestrationListAgentRunsInput.Type;

export const OrchestrationListAgentRunsResult = Schema.Struct({
  runs: Schema.Array(OrchestrationAgentRun),
});
export type OrchestrationListAgentRunsResult = typeof OrchestrationListAgentRunsResult.Type;

export const OrchestrationGetCardDiffInput = Schema.Struct({
  cardId: CardId,
});
export type OrchestrationGetCardDiffInput = typeof OrchestrationGetCardDiffInput.Type;

/** A card's changes against its base branch, for reviewing attempts side by side. */
export const OrchestrationGetCardDiffResult = Schema.Struct({
  baseBranch: Schema.String,
  diff: Schema.String,
  truncated: Schema.Boolean,
});
export type OrchestrationGetCardDiffResult = typeof OrchestrationGetCardDiffResult.Type;

/** An agent as a client sends it to be written to `.iskra/agents/<name>.md`. */
export const AgentDefinitionInput = Schema.Struct({
  id: Schema.NullOr(AgentId),
  name: AgentName,
  avatar: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  modelSelection: ModelSelection,
  capabilities: RunCapabilities,
  rolePrompt: Schema.String,
});
export type AgentDefinitionInput = typeof AgentDefinitionInput.Type;

export const OrchestrationSaveAgentDefinitionInput = Schema.Struct({
  projectId: ProjectId,
  definition: AgentDefinitionInput,
});
export type OrchestrationSaveAgentDefinitionInput =
  typeof OrchestrationSaveAgentDefinitionInput.Type;

export const OrchestrationSaveAgentDefinitionResult = Schema.Struct({
  agentId: AgentId,
});
export type OrchestrationSaveAgentDefinitionResult =
  typeof OrchestrationSaveAgentDefinitionResult.Type;

/** A project secret's name, as setup scripts and env templates refer to it. */
export const PROJECT_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ProjectSecretName = TrimmedNonEmptyString.check(Schema.isPattern(PROJECT_SECRET_NAME_PATTERN));

/** Stores a project secret's value on the environment. Write-only: no RPC returns a value. */
export const OrchestrationSetProjectSecretInput = Schema.Struct({
  projectId: ProjectId,
  name: ProjectSecretName,
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
});
export type OrchestrationSetProjectSecretInput = typeof OrchestrationSetProjectSecretInput.Type;

export const OrchestrationRemoveProjectSecretInput = Schema.Struct({
  projectId: ProjectId,
  name: ProjectSecretName,
});
export type OrchestrationRemoveProjectSecretInput = typeof OrchestrationRemoveProjectSecretInput.Type;

export const OrchestrationImportAgentDefinitionsInput = Schema.Struct({
  projectId: ProjectId,
});
export type OrchestrationImportAgentDefinitionsInput =
  typeof OrchestrationImportAgentDefinitionsInput.Type;

export const OrchestrationImportAgentDefinitionsResult = Schema.Struct({
  imported: Schema.Array(Schema.Struct({ agentId: AgentId, name: Schema.String })),
  skipped: Schema.Array(Schema.Struct({ file: Schema.String, reason: Schema.String })),
});
export type OrchestrationImportAgentDefinitionsResult =
  typeof OrchestrationImportAgentDefinitionsResult.Type;

export const OrchestrationListAgentDefinitionsInput = Schema.Struct({
  projectId: ProjectId,
});
export type OrchestrationListAgentDefinitionsInput =
  typeof OrchestrationListAgentDefinitionsInput.Type;

/** A project's agents as their files define them, archived ones included. */
export const OrchestrationListAgentDefinitionsResult = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({
      definition: Schema.Struct({ ...AgentDefinitionInput.fields, id: AgentId }),
      archived: Schema.Boolean,
    }),
  ),
});
export type OrchestrationListAgentDefinitionsResult =
  typeof OrchestrationListAgentDefinitionsResult.Type;

/** Archives an agent by deleting its file. Saving its definition again unarchives it. */
export const OrchestrationArchiveAgentDefinitionInput = Schema.Struct({
  projectId: ProjectId,
  agentId: AgentId,
});
export type OrchestrationArchiveAgentDefinitionInput =
  typeof OrchestrationArchiveAgentDefinitionInput.Type;

export const OrchestrationArchiveAgentDefinitionResult = Schema.Struct({});
export type OrchestrationArchiveAgentDefinitionResult =
  typeof OrchestrationArchiveAgentDefinitionResult.Type;

export const OrchestrationListArchivedChannelsInput = Schema.Struct({
  projectId: ProjectId,
});
export type OrchestrationListArchivedChannelsInput =
  typeof OrchestrationListArchivedChannelsInput.Type;

/** An archived channel, as a client lists it to unarchive. */
export const OrchestrationArchivedChannel = Schema.Struct({
  id: ChannelId,
  name: TrimmedNonEmptyString,
  kind: ChannelKind,
  topic: Schema.String,
  archivedAt: IsoDateTime,
});
export type OrchestrationArchivedChannel = typeof OrchestrationArchivedChannel.Type;

/**
 * A project's archived channels, most recently archived first. Archived channels
 * leave the shell stream, so this is how a client finds one to unarchive. DMs are
 * left out: messaging the agent opens a new one.
 */
export const OrchestrationListArchivedChannelsResult = Schema.Struct({
  channels: Schema.Array(OrchestrationArchivedChannel),
});
export type OrchestrationListArchivedChannelsResult =
  typeof OrchestrationListArchivedChannelsResult.Type;

/** How many of a channel's newest messages a channel subscription starts with. */
export const CHANNEL_SUBSCRIBE_MESSAGE_LIMIT = 200;

export const OrchestrationSubscribeChannelInput = Schema.Struct({
  channelId: ChannelId,
});
export type OrchestrationSubscribeChannelInput = typeof OrchestrationSubscribeChannelInput.Type;

/**
 * A channel subscription: the newest messages, then each message as it is
 * posted and each change in a message's delivery. A message can arrive in
 * both; clients keep one per id.
 */
export const OrchestrationChannelStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    messages: Schema.Array(OrchestrationChannelMessage),
  }),
  Schema.Struct({
    kind: Schema.Literal("message"),
    message: OrchestrationChannelMessage,
  }),
  Schema.Struct({
    kind: Schema.Literal("delivery"),
    messageId: MessageId,
    delivery: ChannelMessageDelivery,
  }),
]);
export type OrchestrationChannelStreamItem = typeof OrchestrationChannelStreamItem.Type;

/** How many of a card's newest activities a card subscription starts with. */
export const CARD_SUBSCRIBE_ACTIVITY_LIMIT = 200;

export const OrchestrationSubscribeCardInput = Schema.Struct({
  cardId: CardId,
});
export type OrchestrationSubscribeCardInput = typeof OrchestrationSubscribeCardInput.Type;

/** The items of one evidence recording, as a card subscription carries them. */
const CardEvidenceRecording = Schema.Struct({
  evidenceId: TrimmedNonEmptyString,
  items: Schema.Array(CardEvidenceItem),
});

/**
 * A card subscription, opened only while a card is on screen: its newest activities and the items
 * of its latest evidence, then each activity as it is recorded, each change in an activity's
 * delivery and each new recording. An activity can arrive in both; clients keep one per id.
 */
export const OrchestrationCardStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    activities: Schema.Array(CardActivity),
    evidence: Schema.NullOr(CardEvidenceRecording),
  }),
  Schema.Struct({
    kind: Schema.Literal("activity"),
    activity: CardActivity,
  }),
  Schema.Struct({
    kind: Schema.Literal("delivery"),
    activityId: TrimmedNonEmptyString,
    delivery: ChannelDeliveryStatus,
  }),
  Schema.Struct({
    kind: Schema.Literal("evidence"),
    ...CardEvidenceRecording.fields,
  }),
]);
export type OrchestrationCardStreamItem = typeof OrchestrationCardStreamItem.Type;

export const OrchestrationRpcSchemas = {
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getWorkflowScript: {
    input: OrchestrationGetWorkflowScriptInput,
    output: OrchestrationGetWorkflowScriptResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  searchThreads: {
    input: OrchestrationSearchThreadsInput,
    output: OrchestrationSearchThreadsResult,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationShellSnapshot,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: OrchestrationShellStreamItem,
  },
  subscribeChannel: {
    input: OrchestrationSubscribeChannelInput,
    output: OrchestrationChannelStreamItem,
  },
  subscribeCard: {
    input: OrchestrationSubscribeCardInput,
    output: OrchestrationCardStreamItem,
  },
  listAgentRuns: {
    input: OrchestrationListAgentRunsInput,
    output: OrchestrationListAgentRunsResult,
  },
  getCardDiff: {
    input: OrchestrationGetCardDiffInput,
    output: OrchestrationGetCardDiffResult,
  },
  saveAgentDefinition: {
    input: OrchestrationSaveAgentDefinitionInput,
    output: OrchestrationSaveAgentDefinitionResult,
  },
  importAgentDefinitions: {
    input: OrchestrationImportAgentDefinitionsInput,
    output: OrchestrationImportAgentDefinitionsResult,
  },
  listAgentDefinitions: {
    input: OrchestrationListAgentDefinitionsInput,
    output: OrchestrationListAgentDefinitionsResult,
  },
  archiveAgentDefinition: {
    input: OrchestrationArchiveAgentDefinitionInput,
    output: OrchestrationArchiveAgentDefinitionResult,
  },
  listArchivedChannels: {
    input: OrchestrationListArchivedChannelsInput,
    output: OrchestrationListArchivedChannelsResult,
  },
  setProjectSecret: {
    input: OrchestrationSetProjectSecretInput,
    output: Schema.Struct({}),
  },
  removeProjectSecret: {
    input: OrchestrationRemoveProjectSecretInput,
    output: Schema.Struct({}),
  },
} as const;

export class OrchestrationGetSnapshotError extends Schema.TaggedError<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Reading, writing or applying a project's agent files failed. */
export class AgentDefinitionError extends Schema.TaggedError<AgentDefinitionError>()(
  "AgentDefinitionError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ProjectSecretError extends Schema.TaggedError<ProjectSecretError>()(
  "ProjectSecretError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedError<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
    bootstrapThreadDisposition: Schema.optional(Schema.Literal("deleted")),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedError<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedError<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationSearchThreadsError extends Schema.TaggedError<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
