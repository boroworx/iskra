import {
  AgentId,
  DEFAULT_AGENT_BLUEPRINT,
  DEFAULT_AGENT_ROLES,
  CardId,
  ChannelId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunContextPayload,
  type OrchestrationAgent,
  type OrchestrationChannel,
  type OrchestrationChannelMessage,
} from "@iskra/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildRunContext, renderRunContext } from "./runContext.ts";

const decodeRunContextPayload = Schema.decodeUnknownSync(RunContextPayload);
const projectId = ProjectId.make("project-context");
const channelId = ChannelId.make("channel-backend");

const agent = (id: string, name: string, rolePrompt = ""): OrchestrationAgent => ({
  id: AgentId.make(id),
  projectId,
  name,
  avatar: null,
  roleTags: [],
  rolePrompt,
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
  capabilities: ["read"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  roles: DEFAULT_AGENT_ROLES,
  verifyWith: null,
  blueprint: DEFAULT_AGENT_BLUEPRINT,
});

const backend = agent("agent-backend", "backend", "You own the API.");
const frontend = agent("agent-frontend", "frontend");

const channel = (overrides: Partial<OrchestrationChannel> = {}): OrchestrationChannel => ({
  id: channelId,
  projectId,
  kind: "channel",
  name: "backend",
  topic: "",
  pinnedSpec: "",
  wakeDepth: 30,
  memberAgentIds: [backend.id, frontend.id],
  leadAgentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  ...overrides,
});

const message = (
  index: number,
  overrides: Partial<OrchestrationChannelMessage> = {},
): OrchestrationChannelMessage => ({
  id: MessageId.make(`message-${index}`),
  channelId,
  authorKind: "human",
  authorId: "human",
  body: `message ${index}`,
  createdAt: `2026-01-01T00:00:0${index}.000Z`,
  ...overrides,
});

const messages = [1, 2, 3, 4, 5].map((index) => message(index));
const trigger = message(5);

const historyBodies = (wakeDepth: number) =>
  buildRunContext({
    agent: backend,
    channel: channel({ wakeDepth }),
    agents: [backend, frontend],
    messages,
    trigger,
  }).history.map((entry) => entry.body);

describe("buildRunContext", () => {
  it("hands the agent only the newest wake-depth messages before the trigger", () => {
    expect(historyBodies(3)).toEqual(["message 2", "message 3", "message 4"]);
    expect(historyBodies(1)).toEqual(["message 4"]);
    expect(historyBodies(0)).toEqual([]);
    expect(historyBodies(30)).toEqual(["message 1", "message 2", "message 3", "message 4"]);
  });

  it("names authors the way the agent should read them", () => {
    const payload = buildRunContext({
      agent: backend,
      channel: channel(),
      agents: [backend, frontend],
      messages: [
        message(1),
        message(2, { authorKind: "agent", authorId: frontend.id }),
        message(3, { authorKind: "agent", authorId: "agent-gone" }),
        message(4, { authorKind: "system", authorId: "system" }),
      ],
      trigger,
    });

    expect(payload.history.map((entry) => entry.authorName)).toEqual([
      "user",
      "frontend",
      "agent-gone",
      "system",
    ]);
  });

  it("returns a deterministic record that its stored schema accepts", () => {
    const input = { agent: backend, channel: channel(), agents: [backend], messages, trigger };
    const payload = buildRunContext(input);

    expect(buildRunContext(input)).toEqual(payload);
    expect(decodeRunContextPayload(payload)).toEqual(payload);
  });
});

describe("renderRunContext", () => {
  it("renders the exact prompt text for a channel wake", () => {
    const payload = buildRunContext({
      agent: backend,
      channel: channel({ wakeDepth: 2, topic: "API work", pinnedSpec: "Use REST." }),
      agents: [backend, frontend],
      messages: [message(3, { authorKind: "agent", authorId: frontend.id }), message(4), trigger],
      trigger,
    });

    expect(renderRunContext(payload)).toEqual({
      systemPrompt: [
        "You are @backend, an agent working in #backend.",
        "You own the API.",
        "## Channel topic\n\nAPI work",
        "## Pinned spec\n\nUse REST.",
      ].join("\n\n"),
      firstMessage: [
        "Recent messages in #backend:\n" +
          "[2026-01-01T00:00:03.000Z] @frontend: message 3\n" +
          "[2026-01-01T00:00:04.000Z] user: message 4",
        "New message for you:\n[2026-01-01T00:00:05.000Z] user: message 5",
      ].join("\n\n"),
    });
  });

  it("leaves out empty sections and addresses a DM to the user", () => {
    const rendered = renderRunContext(
      buildRunContext({
        agent: frontend,
        channel: channel({ kind: "dm", name: "dm-frontend", wakeDepth: 0 }),
        agents: [frontend],
        messages,
        trigger,
      }),
    );

    expect(rendered).toEqual({
      systemPrompt: "You are @frontend, an agent working in a direct message with the user.",
      firstMessage: "New message for you:\n[2026-01-01T00:00:05.000Z] user: message 5",
    });
  });

  it("names Requests plainly, never as a #channel", () => {
    const rendered = renderRunContext(
      buildRunContext({
        agent: backend,
        channel: channel({ kind: "requests", name: "Requests", wakeDepth: 1 }),
        agents: [backend],
        messages: [message(4), trigger],
        trigger,
      }),
    );

    expect(rendered.systemPrompt).toBe(
      "You are @backend, an agent working in the project's Requests conversation, where the user asks for work.\n\nYou own the API.",
    );
    expect(rendered.firstMessage).toContain("Recent messages in Requests:\n");
  });

  it("renders the exact prompt text for a lead wake", () => {
    const payload = buildRunContext({
      agent: backend,
      channel: channel({ wakeDepth: 1, topic: "API work" }),
      agents: [backend, frontend],
      messages: [message(4), trigger],
      trigger,
    });
    // A lead reads each member's role in a line, to suggest who owns what it proposes.
    expect(
      buildRunContext({
        agent: backend,
        channel: channel(),
        agents: [backend, frontend],
        messages: [],
        trigger,
        lead: { cards: [] },
      }).lead?.members,
    ).toEqual([
      { name: "backend", roleTags: [], summary: "You own the API." },
      { name: "frontend", roleTags: [] },
    ]);
    const lead = {
      members: [
        { name: backend.name, roleTags: [] },
        { name: frontend.name, roleTags: ["ui", "css"], summary: "Builds the web UI." },
      ],
      openCards: [{ id: CardId.make("card-1"), title: "Rate limiting", status: "ready" as const }],
    };

    expect(renderRunContext({ ...payload, lead })).toEqual({
      systemPrompt: [
        "You are @backend, the lead of #backend. You read the messages there that mention no one and turn requests for work into proposed cards, which people then approve.",
        "Your final text is posted in the channel as your reply, so keep it short. You never assign, approve or wake agents.",
        "Read the recent messages first: a reply to a question you asked completes the request it was about.",
        "If the request is too vague to act on, or the work you would propose wouldn't get the requester to their goal, call ask_clarification with one short question, two or three answers and the one you recommend, then end your turn without replying. Propose nothing yet.",
        'Otherwise, for each distinct piece of work it asks for, call propose_triage_card once with a short title, a plain-language spec, your reasoning, two to five acceptance criteria a person can observe (mark ones only a person can check, such as mobile behavior, manual), an estimate with a split when it is too big for one card, the premise, the ids of open cards it likely duplicates, and as suggestedAgent the channel member best suited to own it. Then reply with one short line, such as "Proposed a card below."',
        "If the request asks to plan, break down or map out remaining work as cards, call propose_triage_card once with kind plan, criteria that describe the plan's outcome, and as suggestedAgent a coordinator agent if the project has one, instead of task cards that write documents.",
        "Never write a spec that depends on a later step no one is assigned to, such as the lead turning a document into cards.",
        "If the message asks for no work, answer it in a sentence or two.",
        "Never ask the user to run commands, fetch data or do the work for you; propose a card for work instead.",
        "You own the API.",
        "## Channel topic\n\nAPI work",
        "## Channel members\n\n- @backend\n- @frontend (ui, css): Builds the web UI.",
      ].join("\n\n"),
      firstMessage: [
        "Recent messages in #backend:\n[2026-01-01T00:00:04.000Z] user: message 4",
        "## Open cards\n\n- card-1 [ready] Rate limiting",
        "New message for you:\n[2026-01-01T00:00:05.000Z] user: message 5",
      ].join("\n\n"),
    });
    expect(
      renderRunContext({ ...payload, history: [], lead: { members: [], openCards: [] } })
        .firstMessage,
    ).toBe(
      "## Open cards\n\nNo open cards.\n\nNew message for you:\n[2026-01-01T00:00:05.000Z] user: message 5",
    );
  });
});
