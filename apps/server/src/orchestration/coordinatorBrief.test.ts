import { AgentId, CardId, type OrchestrationAgent, type OrchestrationCard } from "@iskra/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildCoordinatorBrief } from "./coordinatorBrief.ts";

const agent = (
  name: string,
  roles: OrchestrationAgent["roles"],
  archivedAt: string | null = null,
) =>
  ({
    id: AgentId.make(`agent-${name}`),
    name,
    roles,
    rolePrompt: "",
    archivedAt,
  }) as unknown as OrchestrationAgent;

describe("buildCoordinatorBrief", () => {
  it("offers only active builders, shows each child's progress and the messages meant for it", () => {
    const coordinator = agent("lead-planner", ["coordinator"]);
    const card = {
      id: CardId.make("card-plan"),
      title: "Health and version",
      spec: "Add /health and /version.",
      branch: null,
      acceptance: {
        criteria: [{ id: "c1", text: "Both answer.", verification: "automated" }],
        state: "confirmed",
      },
      plan: null,
    } as unknown as OrchestrationCard;
    const child = {
      id: CardId.make("card-health"),
      planKey: "health",
      title: "Health",
      status: "inProgress",
      paused: null,
      waitReason: { code: "blocked", text: "Waits for another card." },
    } as unknown as OrchestrationCard;
    const { context, rendered } = buildCoordinatorBrief({
      agent: coordinator,
      card,
      agents: [
        coordinator,
        agent("backend", ["builder"]),
        agent("gone", ["builder"], "2026-01-01T00:00:00.000Z"),
      ],
      children: [child],
      activities: [
        {
          activityId: "a1",
          kind: "status",
          author: { kind: "system", id: "system" },
          body: "Slice 1 started.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          activityId: "a2",
          kind: "message",
          author: { kind: "human", id: "human" },
          body: "Keep /version tiny.",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      baseBranch: "main",
    });
    expect(context.role).toBe("coordinator");
    const body = (title: string) =>
      context.sections?.find((section) => section.title === title)?.body;
    expect(body("Builders")).toBe("- @backend");
    expect(body("Plan")).toBe("No plan proposed yet.");
    expect(body("Children")).toBe(
      '- health "Health": inProgress, waiting: Waits for another card.',
    );
    expect(body("Messages")).toContain("Keep /version tiny.");
    expect(body("Messages")).not.toContain("Slice 1 started.");
    expect(rendered.systemPrompt).toContain("propose_plan");
    expect(rendered.systemPrompt).toContain("never approve it yourself");
  });
});
