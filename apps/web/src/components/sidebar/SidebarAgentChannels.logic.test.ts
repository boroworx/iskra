import { AgentId, ChannelId, ProjectId } from "@t3tools/contracts";
import type { OrchestrationAgentShell, OrchestrationChannelShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  presenceDotClassName,
  presenceLabel,
  sidebarAgentEntries,
  sidebarChannelEntries,
} from "./SidebarAgentChannels.logic";

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

describe("sidebarChannelEntries", () => {
  it("lists a project's channels by name, then its DMs named for their agent", () => {
    const backend = agent("agent-backend", "backend");
    const frontend = agent("agent-frontend", "frontend");
    const entries = sidebarChannelEntries(
      [
        channel("dm-frontend", "dm-frontend", { kind: "dm", memberAgentIds: [frontend.id] }),
        channel("general", "general"),
        channel("elsewhere", "elsewhere", { projectId: otherProjectId }),
        channel("api", "api"),
        channel("dm-backend", "dm-backend", { kind: "dm", memberAgentIds: [backend.id] }),
      ],
      [backend, frontend],
      projectId,
    );

    expect(entries.map((entry) => entry.label)).toEqual([
      "#api",
      "#general",
      "@backend",
      "@frontend",
    ]);
  });

  it("falls back to the channel name when a DM's agent is not listed", () => {
    const entries = sidebarChannelEntries(
      [channel("dm-gone", "dm-gone", { kind: "dm", memberAgentIds: [AgentId.make("gone")] })],
      [],
      projectId,
    );

    expect(entries.map((entry) => entry.label)).toEqual(["@dm-gone"]);
  });
});

describe("sidebarAgentEntries", () => {
  it("lists only the project's agents, in name order, with their presence", () => {
    const entries = sidebarAgentEntries(
      [
        agent("agent-writer", "writer", { presence: "blocked" }),
        agent("agent-other", "other", { projectId: otherProjectId }),
        agent("agent-backend", "backend", { presence: "running" }),
      ],
      projectId,
    );

    expect(entries).toEqual([
      { key: "agent-backend", name: "backend", presence: "running" },
      { key: "agent-writer", name: "writer", presence: "blocked" },
    ]);
  });
});

describe("presence", () => {
  it("gives every presence a distinct dot colour and label", () => {
    const presences = ["idle", "running", "blocked"] as const;
    expect(new Set(presences.map(presenceDotClassName)).size).toBe(3);
    expect(presences.map(presenceLabel)).toEqual(["Idle", "Working", "Waiting on you"]);
  });
});
