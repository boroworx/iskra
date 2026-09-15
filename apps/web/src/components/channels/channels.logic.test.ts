import {
  AgentId,
  CardId,
  ChannelId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@iskra/contracts";
import type {
  OrchestrationAgentRun,
  OrchestrationAgentShell,
  OrchestrationCard,
  OrchestrationChannelMessage,
  OrchestrationChannelShell,
  OrchestrationMessage,
  OrchestrationThreadActivity,
} from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentListEntries,
  cardNoteOf,
  cardProposalStatus,
  channelListEntries,
  channelMemberEntries,
  channelMessageRows,
  deliveryNotes,
  leadCandidates,
  liveInstances,
  ownerCandidates,
  dmTargets,
  mentionCandidates,
  mentionQueryAt,
  proposalAnchors,
  runOutputItems,
  presenceDotClassName,
  presenceLabel,
  sessionWhere,
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
    leadAgentId: null,
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

const proposal = (
  overrides: Partial<Pick<OrchestrationCard, "channelId" | "sourceMessageId" | "createdBy">> = {},
): Pick<OrchestrationCard, "id" | "channelId" | "sourceMessageId" | "createdBy" | "createdAt"> => ({
  id: CardId.make("card-page"),
  channelId: ChannelId.make("general"),
  sourceMessageId: MessageId.make("ask"),
  createdBy: { kind: "lead", id: "agent-lead" },
  createdAt: "2026-01-01T10:01:00.000Z",
  ...overrides,
});

describe("proposalAnchors", () => {
  const general = ChannelId.make("general");
  const ask = message("ask", "human", "human", "2026-01-01T10:00:00.000Z");
  const earlier = message("earlier", "agent", "agent-lead", "2026-01-01T10:00:30.000Z");
  const reply = message("reply", "agent", "agent-lead", "2026-01-01T10:01:05.000Z");

  it("puts a lead's proposal under its reply, or under its message until the reply arrives", () => {
    const card = proposal();
    expect(proposalAnchors([ask], [card], general)).toEqual(new Map([["ask", [card]]]));
    expect(proposalAnchors([ask, earlier, reply], [card], general)).toEqual(
      new Map([["reply", [card]]]),
    );
  });

  it("leaves out other channels' cards, cards no lead proposed, and cards whose message isn't loaded", () => {
    const cards = [
      proposal({ channelId: ChannelId.make("other") }),
      proposal({ createdBy: { kind: "human", id: "human" } }),
      proposal({ sourceMessageId: MessageId.make("gone") }),
    ];
    expect(proposalAnchors([ask, reply], cards, general).size).toBe(0);
  });
});

describe("cardProposalStatus", () => {
  it("waits for a person until the card has an owner, then follows the card", () => {
    const agents = [{ id: AgentId.make("agent-frontend"), name: "frontend" }];
    const owned = { delegateAgentId: AgentId.make("agent-frontend") };
    expect(cardProposalStatus({ status: "triage", delegateAgentId: null }, agents)).toBeNull();
    expect(cardProposalStatus({ status: "ready", delegateAgentId: null }, agents)).toBeNull();
    expect(cardProposalStatus({ ...owned, status: "ready" }, agents)).toBe("Starting · @frontend");
    expect(cardProposalStatus({ ...owned, status: "inProgress" }, agents)).toBe(
      "In progress · @frontend",
    );
    expect(cardProposalStatus({ ...owned, status: "inReview" }, agents)).toBe("Ready for review");
    expect(cardProposalStatus({ ...owned, status: "landed" }, agents)).toBe("Landed");
    expect(cardProposalStatus({ ...owned, status: "abandoned" }, agents)).toBe("Dropped");
  });
});

describe("cardNoteOf", () => {
  it("reads the card from a progress note's id, and only from Iskra's notes", () => {
    const note = message("event-1:card-progress:card-page", "system", "system", "2026-01-01T10:00:00.000Z");
    const question = message("event-2:card-question:card-page", "system", "system", "2026-01-01T10:00:00.000Z");
    const typed = message("event-3:card-progress:card-page", "human", "human", "2026-01-01T10:00:00.000Z");
    expect(cardNoteOf(note)).toEqual({ cardId: "card-page", question: false });
    expect(cardNoteOf(question)).toEqual({ cardId: "card-page", question: true });
    expect(cardNoteOf(typed)).toBeNull();
    expect(cardNoteOf(message("ask:system:nobody", "system", "system", "2026-01-01T10:00:00.000Z"))).toBeNull();
  });
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
  it("lists a project's agents by name with their presence", () => {
    const entries = agentListEntries(
      [
        agent("agent-writer", "writer", { presence: "blocked" }),
        agent("agent-other", "other", { projectId: otherProjectId }),
        agent("agent-backend", "backend", { presence: "running" }),
      ],
      projectId,
    );

    expect(entries.map((entry) => [entry.name, entry.presence])).toEqual([
      ["backend", "running"],
      ["writer", "blocked"],
    ]);
  });
});

describe("ownerCandidates", () => {
  const agents = [
    agent("agent-legacy", "legacy"),
    agent("agent-lead", "lead", { roles: ["lead"] }),
    agent("agent-verifier", "verifier-oc", { roles: ["verifier"] }),
    agent("agent-coordinator", "coordinator", { roles: ["builder", "coordinator"] }),
  ];
  const names = (entries: ReadonlyArray<{ readonly name: string }>) =>
    entries.map((entry) => entry.name);

  it("offers builders for a task, counting agents without roles as having the defaults", () => {
    expect(names(ownerCandidates(agents, "task", null))).toEqual(["legacy", "coordinator"]);
  });

  it("offers only coordinators for a plan card", () => {
    expect(names(ownerCandidates(agents, "plan", null))).toEqual(["coordinator"]);
  });

  it("keeps the current owner after it stops qualifying", () => {
    expect(names(ownerCandidates(agents, "plan", AgentId.make("agent-lead")))).toEqual([
      "lead",
      "coordinator",
    ]);
  });
});

describe("leadCandidates", () => {
  it("offers agents that may lead, counting agents without roles as having the defaults", () => {
    const agents = [
      agent("agent-legacy", "legacy"),
      agent("agent-verifier", "verifier-oc", { roles: ["verifier"] }),
      agent("agent-builder", "builder", { roles: ["builder", "lead"] }),
      agent("agent-other", "other", { projectId: otherProjectId }),
    ];
    expect(leadCandidates(agents, projectId, null).map((entry) => entry.name)).toEqual([
      "builder",
      "legacy",
    ]);
  });

  it("keeps the current lead after it loses the role, so the picker still shows it", () => {
    const agents = [agent("agent-former", "former", { roles: ["verifier"] })];
    expect(
      leadCandidates(agents, projectId, AgentId.make("agent-former")).map((entry) => entry.name),
    ).toEqual(["former"]);
  });
});

describe("dmTargets", () => {
  const run = (threadId: string, overrides: Partial<OrchestrationAgentRun>): OrchestrationAgentRun => ({
    threadId: ThreadId.make(threadId),
    role: "conversation",
    channelId: null,
    cardId: null,
    agentId: AgentId.make("agent-backend"),
    triggerMessageId: null,
    capabilities: ["read"],
    context: {
      agent: { id: AgentId.make("agent-backend"), name: "backend", rolePrompt: "" },
      role: "owner",
      card: { id: CardId.make("card-limits"), title: "Rate limiting", spec: "", branch: null, baseBranch: "main" },
      decisions: [],
      diff: "",
      diffTruncated: false,
      question: null,
    },
    rendered: { systemPrompt: "", firstMessage: "" },
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    cardTitle: null,
    ...overrides,
  });

  it("offers the agent's live conversations and owned cards, newest first, never a helper", () => {
    const backend = channel("channel-backend", "backend");
    const card = { cardId: CardId.make("card-limits"), cardTitle: "Rate limiting" };

    const targets = dmTargets(
      [
        run("run-conversation", { channelId: backend.id, startedAt: "2026-01-01T00:00:00.000Z" }),
        run("run-owner", { ...card, role: "owner", startedAt: "2026-01-02T00:00:00.000Z" }),
        run("run-helper", { ...card, role: "helper", startedAt: "2026-01-03T00:00:00.000Z" }),
        run("run-ended", {
          channelId: backend.id,
          startedAt: "2026-01-04T00:00:00.000Z",
          endedAt: "2026-01-04T00:01:00.000Z",
        }),
      ],
      [backend],
    );

    expect(targets).toEqual([
      { threadId: null, label: "Direct message" },
      { threadId: "run-owner", label: "Rate limiting" },
      { threadId: "run-conversation", label: "#backend" },
    ]);
  });

  it("puts the DM first and leaves out a live run in the DM itself", () => {
    const dm = channel("dm:m1", "dm-backend", {
      kind: "dm",
      memberAgentIds: [AgentId.make("agent-backend")],
    });

    expect(dmTargets([run("run-dm", { channelId: dm.id })], [dm])).toEqual([
      { threadId: null, label: "Direct message" },
    ]);
  });

  it("lists every live run of an agent as its own instance, newest first", () => {
    const dm = channel("dm:m1", "dm-backend", { kind: "dm" });
    const general = channel("channel-general", "general");
    const other = channel("channel-other", "other");

    expect(
      liveInstances(
        [
          run("run-a", { channelId: general.id, startedAt: "2026-01-01T00:01:00.000Z" }),
          run("run-b", { channelId: other.id, startedAt: "2026-01-01T00:02:00.000Z" }),
          run("run-dm", { channelId: dm.id, startedAt: "2026-01-01T00:03:00.000Z" }),
          run("run-verify", {
            role: "verifier",
            cardTitle: "Add /health",
            startedAt: "2026-01-01T00:04:00.000Z",
          }),
          run("run-ended", { channelId: general.id, endedAt: "2026-01-01T00:05:00.000Z" }),
        ],
        [dm, general, other],
      ).map((instance) => `${instance.doing} ${instance.where}`),
    ).toEqual([
      "Verifying Add /health",
      "Replying in this DM",
      "Replying in #other",
      "Replying in #general",
    ]);
  });

  it("labels a run in the agent's DM as this DM, and one in a channel by name", () => {
    const dm = channel("dm:m1", "dm-backend", { kind: "dm" });
    const backend = channel("channel-backend", "backend");

    expect(sessionWhere(run("run-dm", { channelId: dm.id }), [dm, backend])).toBe("this DM");
    expect(sessionWhere(run("run-channel", { channelId: backend.id }), [dm, backend])).toBe(
      "#backend",
    );
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

  it("never says queued: a delivery an older server queued is just waiting", () => {
    const queued = {
      ...message("q", "human", "human", "2026-01-01T10:00:00.000Z"),
      deliveries: [{ agentId: AgentId.make("agent-backend"), status: "queued" as const }],
    };

    expect(
      deliveryNotes(queued, [agent("agent-backend", "backend")]).map((note) => note.text),
    ).toEqual(["Waiting for @backend"]);
  });
});

describe("mentions", () => {
  it("finds the mention being typed at the cursor, but not an email address or a finished one", () => {
    expect(mentionQueryAt("hi @Al", 6)).toEqual({ start: 3, query: "al" });
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("hi @al there", 6)).toEqual({ start: 3, query: "al" });
    expect(mentionQueryAt("mail dev@backend", 16)).toBeNull();
    expect(mentionQueryAt("@alice ", 7)).toBeNull();
  });

  it("offers names starting with the query before names containing it", () => {
    const names = [{ name: "backend" }, { name: "alice" }, { name: "al" }, { name: "sally" }];
    expect(mentionCandidates(names, "al").map((entry) => entry.name)).toEqual([
      "alice",
      "al",
      "sally",
    ]);
    expect(mentionCandidates(names, "")).toHaveLength(4);
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
