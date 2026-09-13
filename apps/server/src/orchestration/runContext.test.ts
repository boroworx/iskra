import {
  AgentId,
  ChannelId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunContextPayload,
  type OrchestrationAgent,
  type OrchestrationChannel,
  type OrchestrationChannelMessage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildRunContext, renderAgentDmPrompt, renderRunContext } from "./runContext.ts";

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
});

const backend = agent("agent-backend", "backend", "You own the API.");
const frontend = agent("agent-frontend", "frontend");

describe("renderAgentDmPrompt", () => {
  it("names the agent and adds its role, leaving out an empty role", () => {
    expect(renderAgentDmPrompt(backend)).toBe(
      "You are @backend, an agent on this project's team, working directly with a person in this repository.\n\nYou own the API.",
    );
    expect(renderAgentDmPrompt(frontend)).not.toContain("\n");
  });
});

const channel = (overrides: Partial<OrchestrationChannel> = {}): OrchestrationChannel => ({
  id: channelId,
  projectId,
  kind: "channel",
  name: "backend",
  topic: "",
  pinnedSpec: "",
  wakeDepth: 30,
  memberAgentIds: [backend.id, frontend.id],
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
});
