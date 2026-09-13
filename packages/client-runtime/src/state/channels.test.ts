import {
  AgentId,
  ChannelId,
  MessageId,
  type ChannelMessageDelivery,
  type OrchestrationChannelMessage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyChannelStreamItem } from "./channels.ts";

const message = (id: string, body = id): OrchestrationChannelMessage => ({
  id: MessageId.make(id),
  channelId: ChannelId.make("general"),
  authorKind: "human",
  authorId: "human",
  body,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("applyChannelStreamItem", () => {
  it("keeps one copy of a message that arrives in the snapshot and live", () => {
    const afterSnapshot = applyChannelStreamItem([], {
      kind: "snapshot",
      messages: [message("a"), message("b")],
    });
    const afterLive = [message("b"), message("c")].reduce(
      (messages, live) => applyChannelStreamItem(messages, { kind: "message", message: live }),
      afterSnapshot,
    );

    expect(afterLive.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps each agent's latest delivery standing on a message", () => {
    const backend = AgentId.make("backend");
    const writer = AgentId.make("writer");
    const deliveries: ReadonlyArray<ChannelMessageDelivery> = [
      { agentId: backend, status: "pending" },
      { agentId: writer, status: "pending" },
      { agentId: backend, status: "delivered" },
    ];
    let next: ReadonlyArray<OrchestrationChannelMessage> = [message("a"), message("b")];
    for (const delivery of deliveries) {
      next = applyChannelStreamItem(next, {
        kind: "delivery",
        messageId: MessageId.make("b"),
        delivery,
      });
    }

    expect(next[0]?.deliveries).toBeUndefined();
    expect(next[1]?.deliveries).toEqual([
      { agentId: "writer", status: "pending" },
      { agentId: "backend", status: "delivered" },
    ]);
  });

  it("replaces held messages with a resubscription's snapshot", () => {
    const held = [message("a"), message("b")];
    const next = applyChannelStreamItem(held, { kind: "snapshot", messages: [message("b")] });

    expect(next.map((entry) => entry.id)).toEqual(["b"]);
  });
});
