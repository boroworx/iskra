import { describe, expect, it } from "vite-plus/test";

import { AgentId, ChannelId, ProjectId, ProviderInstanceId, ThreadId } from "@iskra/contracts";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@iskra/contracts";

import { applyShellStreamEvent } from "./shellReducer.ts";

const baseSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const stubProject = {
  id: ProjectId.make("project-1"),
  title: "Test Project",
  workspaceRoot: "/workspace/test",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
} as const;

const stubThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
} as const;

describe("applyShellStreamEvent", () => {
  it("ignores stale project upserts without mutating the snapshot", () => {
    const snapshotWithProject: OrchestrationShellSnapshot = {
      ...baseSnapshot,
      snapshotSequence: 4,
      projects: [stubProject],
    };

    for (const sequence of [3, 4]) {
      const next = applyShellStreamEvent(snapshotWithProject, {
        kind: "project-upserted",
        sequence,
        project: { ...stubProject, title: "Stale Title" },
      });

      expect(next).toBe(snapshotWithProject);
      expect(next.snapshotSequence).toBe(4);
      expect(next.projects[0]?.title).toBe("Test Project");
    }
  });

  describe("cards", () => {
  it("applies a card update that shares its sequence with the agent update before it", () => {
    const base = { snapshotSequence: 4, projects: [], threads: [], updatedAt: "2026-01-01T00:00:00.000Z" };
    const card = {
      id: "card-1",
      title: "Rate limiting",
    } as unknown as NonNullable<OrchestrationShellSnapshot["cards"]>[number];
    const upserted = applyShellStreamEvent(base, { kind: "card-upserted", sequence: 4, card });
    expect(upserted.cards).toEqual([card]);
    const renamed = { ...card, title: "Rate limits" };
    expect(
      applyShellStreamEvent(upserted, { kind: "card-upserted", sequence: 5, card: renamed }).cards,
    ).toEqual([renamed]);
    expect(applyShellStreamEvent({ ...upserted, snapshotSequence: 6 }, {
      kind: "card-upserted",
      sequence: 5,
      card: renamed,
    }).cards).toEqual([card]);
  });
});

describe("agents and channels", () => {
    const agent = {
      id: AgentId.make("agent-1"),
      projectId: ProjectId.make("project-1"),
      name: "backend",
      avatar: null,
      roleTags: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-4-5",
      },
      presence: "idle" as const,
    };
    const channel = {
      id: ChannelId.make("channel-1"),
      projectId: ProjectId.make("project-1"),
      kind: "channel" as const,
      name: "general",
      topic: "",
      memberAgentIds: [agent.id],
    };

    it("adds, updates and removes agents on a snapshot that has none yet", () => {
      const added = applyShellStreamEvent(baseSnapshot, {
        kind: "agent-upserted",
        sequence: 1,
        agent,
      });
      expect(added.agents).toEqual([agent]);

      const running = applyShellStreamEvent(added, {
        kind: "agent-upserted",
        sequence: 2,
        agent: { ...agent, presence: "running" },
      });
      expect(running.agents?.map((entry) => entry.presence)).toEqual(["running"]);

      const removed = applyShellStreamEvent(running, {
        kind: "agent-removed",
        sequence: 3,
        agentId: agent.id,
      });
      expect(removed.agents).toEqual([]);
      expect(removed.snapshotSequence).toBe(3);
    });

    it("adds and removes channels on a snapshot that has none yet", () => {
      const added = applyShellStreamEvent(baseSnapshot, {
        kind: "channel-upserted",
        sequence: 1,
        channel,
      });
      expect(added.channels).toEqual([channel]);

      const removed = applyShellStreamEvent(added, {
        kind: "channel-removed",
        sequence: 2,
        channelId: channel.id,
      });
      expect(removed.channels).toEqual([]);
    });
  });

  describe("project-upserted", () => {
    it("adds a new project", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 1,
        project: stubProject,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.id).toBe("project-1");
      expect(next.snapshotSequence).toBe(1);
    });

    it("updates an existing project", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const updatedProject = { ...stubProject, title: "Updated Title" };
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 2,
        project: updatedProject,
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.title).toBe("Updated Title");
      expect(next.snapshotSequence).toBe(2);
    });
  });

  describe("project-removed", () => {
    it("removes a project by id", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "project-removed",
        sequence: 3,
        projectId: ProjectId.make("project-1"),
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(0);
      expect(next.snapshotSequence).toBe(3);
    });
  });

  describe("thread-upserted", () => {
    it("adds a new thread", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 4,
        thread: stubThread,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.id).toBe("thread-1");
      expect(next.snapshotSequence).toBe(4);
    });

    it("updates an existing thread", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const updatedThread = { ...stubThread, title: "Updated Thread" };
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 5,
        thread: updatedThread,
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.title).toBe("Updated Thread");
    });
  });

  describe("thread-removed", () => {
    it("removes a thread by id", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "thread-removed",
        sequence: 6,
        threadId: ThreadId.make("thread-1"),
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(0);
      expect(next.snapshotSequence).toBe(6);
    });
  });

  it("returns original snapshot for unrecognized event kinds", () => {
    const unknownEvent = { kind: "unknown-future-event", sequence: 99 } as any;
    const next = applyShellStreamEvent(baseSnapshot, unknownEvent);
    expect(next).toBe(baseSnapshot);
  });
});
