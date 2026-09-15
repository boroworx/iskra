import type {
  CardActivity,
  CardBriefPayload,
  OrchestrationAgent,
  OrchestrationCard,
  RenderedRunContext,
} from "@iskra/contracts";

import { renderCardActivities } from "./cardBrief.ts";

/** The most of a coordinator's recent messages its brief carries, newest kept. */
export const COORDINATOR_MESSAGES_LIMIT = 20_000;
const MESSAGE_KINDS: ReadonlySet<CardActivity["kind"]> = new Set([
  "message",
  "response",
  "decision",
  "error",
  "elicitation",
]);

export interface CoordinatorBriefInput {
  readonly agent: OrchestrationAgent;
  readonly card: OrchestrationCard;
  /** The project's agents: builders are offered as suggested agents, and name message authors. */
  readonly agents: ReadonlyArray<OrchestrationAgent>;
  /** The plan's child cards. */
  readonly children: ReadonlyArray<OrchestrationCard>;
  /** The plan card's recent activities, oldest first. */
  readonly activities: ReadonlyArray<
    Pick<CardActivity, "activityId" | "kind" | "author" | "body" | "createdAt">
  >;
  readonly baseBranch: string;
}

const list = (lines: ReadonlyArray<string>, empty: string) =>
  lines.length === 0 ? empty : lines.join("\n");

/**
 * The brief a plan card's coordinator starts from: the goal, the builders it can suggest, its plan
 * so far with each child's progress, and what people and Iskra told it. Pure.
 */
export function buildCoordinatorBrief(input: CoordinatorBriefInput): {
  readonly context: CardBriefPayload;
  readonly rendered: RenderedRunContext;
} {
  const { agent, card } = input;
  const plan = card.plan;
  const builders = input.agents.filter(
    (candidate) => candidate.archivedAt === null && candidate.roles.includes("builder"),
  );
  const planBody =
    plan === null || plan.revision === 0
      ? "No plan proposed yet."
      : [
          `Revision ${plan.revision}, ${plan.state}.${plan.integrationBranch === null ? "" : ` Children land into \`${plan.integrationBranch}\`; slice ${plan.currentSlice} is open.`}`,
          plan.premise.trim(),
          ...plan.children.map(
            (child) =>
              `- ${child.key} "${child.title}": slice ${child.slice}${child.dependsOn.length === 0 ? "" : `, after ${child.dependsOn.join(", ")}`}${child.suggestedAgent === null ? "" : `, @${child.suggestedAgent}`}`,
          ),
        ]
          .filter((line) => line.length > 0)
          .join("\n");
  const messages = renderCardActivities(
    input.activities.filter((activity) => MESSAGE_KINDS.has(activity.kind)),
    input.agents,
  );
  const sections = [
    { title: "Goal", body: card.spec.trim().length === 0 ? card.title : card.spec.trim() },
    {
      title: "Acceptance criteria",
      body: list(
        card.acceptance.criteria.map((criterion) => `- ${criterion.text}`),
        "No criteria yet.",
      ),
    },
    {
      title: "Builders",
      body: list(
        builders.map((builder) => `- @${builder.name}`),
        "No agent in this project can build; leave suggestedAgent empty for a person to assign.",
      ),
    },
    { title: "Plan", body: planBody },
    {
      title: "Children",
      body: list(
        input.children.map(
          (child) =>
            `- ${child.planKey ?? child.id} "${child.title}": ${child.status}${child.paused === null ? "" : `, paused: ${child.paused.reason.text}`}${child.waitReason === null ? "" : `, waiting: ${child.waitReason.text}`}`,
        ),
        "",
      ),
    },
    {
      title: "Messages",
      body:
        messages.length > COORDINATOR_MESSAGES_LIMIT
          ? `…${messages.slice(messages.length - COORDINATOR_MESSAGES_LIMIT)}`
          : messages,
    },
  ].filter((section) => section.body.trim().length > 0);

  const intro = `You are @${agent.name}, coordinating the plan card "${card.title}". You can read the repository but never change it. Break the goal into child cards with propose_plan: give each child a short key, a title, a spec, acceptance criteria a person can observe, the builder that should build it, the keys it depends on, and a slice. Slice 1 runs first; a person checks in before each later slice starts. A person approves your plan; you can never approve it yourself. Once it is approved you get updates as children move: message_child steers a child's builder, pause_child stops a child going wrong, read_child_worklog shows what a child did, ask_plan_owner asks a person to decide something, and propose_plan_lesson suggests something later work in this project should know. When a person redirects the plan, propose a revised one.`;
  const context: CardBriefPayload = {
    agent: { id: agent.id, name: agent.name, rolePrompt: agent.rolePrompt },
    role: "coordinator",
    card: {
      id: card.id,
      title: card.title,
      spec: card.spec,
      branch: card.branch,
      baseBranch: input.baseBranch,
    },
    decisions: [],
    diff: "",
    diffTruncated: false,
    question: null,
    sections,
  };
  return {
    context,
    rendered: {
      systemPrompt: [intro, agent.rolePrompt.trim()].filter((part) => part.length > 0).join("\n\n"),
      firstMessage: [
        `# Coordinator brief: ${card.title}`,
        `Plan for \`${input.baseBranch}\`.`,
        ...sections.map((section) => `## ${section.title}\n\n${section.body}`),
      ].join("\n\n"),
    },
  };
}
