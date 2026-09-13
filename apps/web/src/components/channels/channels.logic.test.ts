import { AgentId, ChannelId, MessageId, ProjectId } from "@t3tools/contracts";
import type {
  OrchestrationAgentShell,
  OrchestrationChannelMessage,
  OrchestrationChannelShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentListEntries,
  channelListEntries,
  channelMemberEntries,
  channelMessageRows,
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
  it("lists every project agent by name, with its DM when it has one", () => {
    const backend = agent("agent-backend", "backend", { presence: "running" });
    const writer = agent("agent-writer", "writer");
    const entries = agentListEntries(
      [channel("dm-backend", "dm-backend", { kind: "dm", memberAgentIds: [backend.id] })],
      [writer, agent("agent-other", "other", { projectId: otherProjectId }), backend],
      projectId,
    );

    expect(entries).toEqual([
      { id: "agent-backend", name: "backend", presence: "running", dmChannelId: "dm-backend" },
      { id: "agent-writer", name: "writer", presence: "idle", dmChannelId: null },
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
