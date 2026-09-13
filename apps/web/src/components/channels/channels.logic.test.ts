import {
  AgentId,
  ChannelId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  agentDmThreadId,
} from "@t3tools/contracts";
import type {
  OrchestrationAgentRun,
  OrchestrationAgentShell,
  OrchestrationChannelMessage,
  OrchestrationChannelShell,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentListEntries,
  channelListEntries,
  channelMemberEntries,
  channelMessageRows,
  deliveryNotes,
  dmTimelineEntries,
  runOutputItems,
  presenceDotClassName,
  presenceLabel,
  toAgentName,
  toChannelName,
} from "./channels.logic";

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");

const agent = (id: string, name: string, overrides: Partial<OrchestrationAgentShell> = {}) =>
  ({
    id: AgentId.make(id),
    projectId,
    name,
    avatar: null,
    roleTags: [],
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-haiku-4-5",
    },
    presence: "idle",
    ...overrides,
  }) satisfies OrchestrationAgentShell;

const channel = (id: string, name: string, overrides: Partial<OrchestrationChannelShell> = {}) =>
  ({
    id: ChannelId.make(id),
    projectId,
    kind: "channel",
    name,
    topic: "",
    memberAgentIds: [],
    ...overrides,
  }) satisfies OrchestrationChannelShell;

const message = (
  id: string,
  authorKind: OrchestrationChannelMessage["authorKind"],
  authorId: string,
  createdAt: string,
): OrchestrationChannelMessage => ({
  id: MessageId.make(id),
  channelId: ChannelId.make("general"),
  authorKind,
  authorId,
  body: id,
  createdAt,
});

describe("channelListEntries", () => {
  it("lists only the project's channels, by name, leaving out DMs", () => {
    const entries = channelListEntries(
      [
        channel("general", "general"),
        channel("dm-backend", "dm-backend", {
          kind: "dm",
          memberAgentIds: [AgentId.make("agent-backend")],
        }),
        channel("elsewhere", "elsewhere", { projectId: otherProjectId }),
        channel("api", "api"),
      ],
      projectId,
    );

    expect(entries.map((entry) => entry.name)).toEqual(["api", "general"]);
  });
});

describe("agentListEntries", () => {
  it("lists a project's agents by name, taking whichever of run or DM presence needs more attention", () => {
    const dm = (
      agentId: string,
      overrides: Partial<
        Pick<OrchestrationThreadShell, "session" | "hasPendingApprovals" | "hasPendingUserInput">
      > = {},
    ) => ({
      id: agentDmThreadId(AgentId.make(agentId)),
      session: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      ...overrides,
    });
    const session = (status: "running" | "ready") =>
      ({ status }) as unknown as OrchestrationThreadShell["session"];

    const entries = agentListEntries(
      [
        agent("agent-writer", "writer"),
        agent("agent-other", "other", { projectId: otherProjectId }),
        agent("agent-backend", "backend", { presence: "running" }),
        agent("agent-reviewer", "reviewer"),
      ],
      [
        dm("agent-writer", { hasPendingApprovals: true }),
        dm("agent-reviewer", { session: session("running") }),
        dm("agent-backend", { session: session("ready") }),
      ],
      projectId,
    );

    expect(entries.map((entry) => [entry.name, entry.presence, entry.dmThreadId])).toEqual([
      ["backend", "running", "dm:agent-backend"],
      ["reviewer", "running", "dm:agent-reviewer"],
      ["writer", "blocked", "dm:agent-writer"],
    ]);
  });
});

describe("channelMemberEntries", () => {
  it("lists only the channel's member agents, in name order, with their presence", () => {
    const general = channel("general", "general", {
      memberAgentIds: [AgentId.make("agent-writer"), AgentId.make("agent-backend")],
    });
    const entries = channelMemberEntries(general, [
      agent("agent-writer", "writer", { presence: "blocked" }),
      agent("agent-other", "other"),
      agent("agent-backend", "backend", { presence: "running" }),
    ]);

    expect(entries).toEqual([
      { id: "agent-backend", name: "backend", presence: "running" },
      { id: "agent-writer", name: "writer", presence: "blocked" },
    ]);
  });
});

describe("channelMessageRows", () => {
  it("names authors and starts a new header when the author changes or five minutes pass", () => {
    const rows = channelMessageRows(
      [
        message("m1", "human", "human", "2026-01-01T10:00:00.000Z"),
        message("m2", "human", "human", "2026-01-01T10:01:00.000Z"),
        message("m3", "agent", "agent-backend", "2026-01-01T10:02:00.000Z"),
        message("m4", "agent", "agent-backend", "2026-01-01T10:08:00.000Z"),
        message("m5", "system", "system", "2026-01-01T10:08:30.000Z"),
      ],
      [agent("agent-backend", "backend")],
    );

    expect(rows.map((row) => [row.authorName, row.showHeader])).toEqual([
      ["You", true],
      ["You", false],
      ["backend", true],
      ["backend", true],
      ["Iskra", true],
    ]);
  });
});

const run = (threadId: string, startedAt: string): OrchestrationAgentRun =>
  ({
    threadId: ThreadId.make(threadId),
    channelId: ChannelId.make("general"),
    agentId: AgentId.make("agent-backend"),
    triggerMessageId: MessageId.make("trigger"),
    capabilities: ["read"],
    startedAt,
    endedAt: null,
  }) as unknown as OrchestrationAgentRun;

describe("dmTimelineEntries", () => {
  it("interleaves runs by time, drops replies their run shows, and heads the message after a run", () => {
    const shownReply = {
      ...message("reply-shown", "agent", "agent-backend", "2026-01-01T10:02:00.000Z"),
      runThreadId: ThreadId.make("run-1"),
    };
    const entries = dmTimelineEntries(
      [
        message("q1", "human", "human", "2026-01-01T10:00:00.000Z"),
        shownReply,
        message("q2", "human", "human", "2026-01-01T10:03:00.000Z"),
      ],
      [run("run-1", "2026-01-01T10:01:00.000Z")],
      [agent("agent-backend", "backend")],
    );

    expect(
      entries.map((entry) =>
        entry.kind === "run"
          ? ["run", entry.run.threadId]
          : ["message", entry.row.message.id, entry.row.showHeader],
      ),
    ).toEqual([
      ["message", "q1", true],
      ["run", "run-1"],
      ["message", "q2", true],
    ]);
  });
});

describe("runOutputItems", () => {
  it("marks assistant text as addressed to the user and activity as ambient, in order", () => {
    const activity = (id: string, kind: string, summary: string, createdAt: string) =>
      ({
        id: EventId.make(id),
        tone: "tool",
        kind,
        summary,
        payload: {},
        turnId: null,
        createdAt,
      }) satisfies OrchestrationThreadActivity;
    const assistant = (
      id: string,
      role: OrchestrationMessage["role"],
      text: string,
      createdAt: string,
    ) =>
      ({
        id: MessageId.make(id),
        role,
        text,
        turnId: null,
        createdAt,
      }) as unknown as OrchestrationMessage;

    const items = runOutputItems({
      messages: [
        assistant("prompt", "user", "New message for you", "2026-01-01T10:00:00.000Z"),
        assistant("answer", "assistant", "It routes mentions.", "2026-01-01T10:00:05.000Z"),
      ],
      activities: [
        activity("read", "tool.started", "Read mentions.ts", "2026-01-01T10:00:01.000Z"),
        activity("read-progress", "tool.progress", "Reading", "2026-01-01T10:00:02.000Z"),
        activity("denied", "tool.denied", "Write denied", "2026-01-01T10:00:03.000Z"),
      ],
    });

    expect(items.map((item) => [item.text, item.addressedToUser])).toEqual([
      ["Read mentions.ts", false],
      ["Write denied", false],
      ["It routes mentions.", true],
    ]);
  });
});

describe("deliveryNotes", () => {
  it("says nothing once read, waits while unread, and warns when never read", () => {
    const question = {
      ...message("q", "human", "human", "2026-01-01T10:00:00.000Z"),
      deliveries: [
        { agentId: AgentId.make("agent-backend"), status: "sent" as const },
        { agentId: AgentId.make("agent-writer"), status: "undelivered" as const },
        { agentId: AgentId.make("agent-reader"), status: "delivered" as const },
      ],
    };

    expect(
      deliveryNotes(question, [
        agent("agent-backend", "backend"),
        agent("agent-writer", "writer"),
      ]).map((note) => [note.text, note.undelivered]),
    ).toEqual([
      ["Waiting for @backend", false],
      ["@writer never read this", true],
    ]);
  });
});

describe("typed names", () => {
  it("joins words with dashes, and keeps only mentionable characters in agent names", () => {
    expect(toChannelName("  Release Notes ")).toBe("release-notes");
    expect(toAgentName(" Backend Reviewer!")).toBe("backend-reviewer");
    expect(toAgentName("@api_v2")).toBe("apiv2");
    expect(toAgentName("a".repeat(80))).toHaveLength(64);
  });
});

describe("presence", () => {
  it("gives every presence a distinct dot colour and label", () => {
    const presences = ["idle", "running", "blocked"] as const;
    expect(new Set(presences.map(presenceDotClassName)).size).toBe(3);
    expect(presences.map(presenceLabel)).toEqual(["Idle", "Working", "Waiting on you"]);
  });
});
