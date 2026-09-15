import {
  MessageId,
  type CardActivity,
  type CardAuthor,
  type CardBriefPayload,
  type CardDiffStat,
  type CardEvidenceItem,
  type CardSessionRole,
  type OrchestrationAgent,
  type OrchestrationCard,
  type RenderedRunContext,
} from "@iskra/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ProjectionCardRepository } from "../persistence/Services/ProjectionCards.ts";
import { renderNewMessage } from "./runContext.ts";

/** Past this many characters a brief's diff is cut, so a large change cannot flood the first turn. */
export const CARD_BRIEF_DIFF_LIMIT = 40_000;
/** The whole worklog stays under this; the digest of older messages goes first. */
export const CARD_WORKLOG_LIMIT = 80_000;
/** Root AGENTS.md/CLAUDE.md are cut here; the provider loads no project settings of its own. */
export const PROJECT_RULES_LIMIT = 8_000;
const MESSAGES_IN_FULL = 10;
const DIGEST_LINES = 40;
const EVIDENCE_TAIL_LIMIT = 2_000;

/** What a card's activity stream and evidence add to a brief. */
export interface CardWorklogInput {
  /** The card's activities, oldest first. */
  readonly activities: ReadonlyArray<CardActivity>;
  /** The items of the card's latest evidence, in capture order. */
  readonly evidenceItems: ReadonlyArray<CardEvidenceItem>;
  /** Root AGENTS.md and CLAUDE.md, or null when the project has neither. */
  readonly projectRules: string | null;
  /** Times the card's owner was restarted before this session. */
  readonly restarts: number;
}

interface CardBriefInput {
  readonly agent: OrchestrationAgent;
  readonly role: CardSessionRole;
  readonly card: OrchestrationCard;
  /** The project's agents, used to name decision authors. */
  readonly agents: ReadonlyArray<OrchestrationAgent>;
  /** Legacy decisions; ignored when a worklog is given, whose decisions come from activities. */
  readonly decisions: ReadonlyArray<{
    readonly author: CardAuthor;
    readonly text: string;
    readonly createdAt: string;
  }>;
  readonly baseBranch: string;
  /** The worktree's full diff against its base; cut here to the limit. */
  readonly diff: string;
  readonly question: string | null;
  readonly worklog?: CardWorklogInput;
}

function authorName(author: CardAuthor, agents: ReadonlyArray<OrchestrationAgent>): string {
  switch (author.kind) {
    case "human":
      return "user";
    case "agent":
      return agents.find((agent) => agent.id === author.id)?.name ?? author.id;
    case "lead":
      return "channel lead";
    case "linear":
      return "Linear";
  }
}

function activityAuthorName(
  author: CardActivity["author"],
  agents: ReadonlyArray<OrchestrationAgent>,
): string {
  switch (author.kind) {
    case "human":
      return "user";
    case "agent":
      return `@${agents.find((agent) => agent.id === author.id)?.name ?? author.id}`;
    case "system":
      return "Iskra";
    case "linear":
      return `${author.id} on Linear`;
    case "github":
      return `${author.id} on GitHub`;
  }
}

const tail = (text: string, limit: number) =>
  text.length > limit ? `…${text.slice(text.length - limit)}` : text;

const oneLine = (text: string, limit = 160) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

type Section = { readonly title: string; readonly body: string };

/** The worklog sections of an owner brief, in the order a session reads them. */
export function worklogSections(input: {
  readonly card: OrchestrationCard;
  readonly agents: ReadonlyArray<OrchestrationAgent>;
  readonly worklog: CardWorklogInput;
  readonly diff: string;
  readonly diffTruncated: boolean;
  readonly question: string | null;
}): ReadonlyArray<Section> {
  const { card, agents, worklog } = input;
  const activities = worklog.activities;
  const name = (activity: CardActivity) => activityAuthorName(activity.author, agents);

  const criteria =
    card.acceptance.criteria.length === 0
      ? "No acceptance criteria. Ask the owner what done looks like before you ask for review."
      : [
          ...card.acceptance.criteria.map(
            (criterion) =>
              `- [${criterion.id}] ${criterion.text}${criterion.verification === "manual" ? " (a person checks this one)" : ""}`,
          ),
          ...(card.acceptance.state === "draft"
            ? ["", "These are still a draft; a person hasn't confirmed them."]
            : []),
        ].join("\n");

  const premise =
    card.premise === null
      ? ""
      : [
          `Goal: ${card.premise.goal}`,
          ...(card.premise.pushback === null ? [] : [`Pushback: ${card.premise.pushback}`]),
        ].join("\n");

  const plan = activities.findLast((activity) => activity.kind === "plan")?.body ?? "";

  const decisions = activities
    .filter((activity) => activity.kind === "decision")
    .map((activity) => `- [${activity.createdAt}] ${name(activity)}: ${activity.body}`)
    .join("\n");

  const answers = new Map(
    activities
      .filter((activity) => activity.kind === "response" && activity.answers !== null)
      .map((activity) => [activity.answers!.questionId, activity] as const),
  );
  const questions = activities
    .filter((activity) => activity.kind === "elicitation")
    .map((activity) => {
      const answer = answers.get(activity.activityId);
      const question = activity.elicitation?.question ?? activity.body;
      const options =
        activity.elicitation === null || activity.elicitation.options.length === 0
          ? ""
          : ` (${activity.elicitation.options.map((option) => option.label).join(" / ")})`;
      return `- Q (${name(activity)}): ${question}${options}\n  A: ${answer === undefined ? "not answered here; any answer came as a message in the session" : `${name(answer)}: ${answer.body}`}`;
    })
    .join("\n");

  const messages = activities.filter(
    (activity) =>
      activity.kind === "message" || activity.kind === "critique" || activity.kind === "help",
  );
  const recent = messages.slice(-MESSAGES_IN_FULL);
  const older = messages.slice(0, -MESSAGES_IN_FULL);
  const digest = older
    .slice(-DIGEST_LINES)
    .map((activity) => `- [${activity.createdAt}] ${name(activity)}: ${oneLine(activity.body)}`);
  const renderMessages = (withDigest: boolean) =>
    [
      ...(withDigest && digest.length > 0
        ? [`Earlier, in brief:\n${digest.join("\n")}`, "Most recent:"]
        : []),
      ...recent.map((activity) => `[${activity.createdAt}] ${name(activity)}: ${activity.body}`),
    ].join("\n\n");

  const evidence = card.evidence;
  const evidenceBody =
    evidence === null
      ? ""
      : [
          `${evidence.purpose === "review" ? "Review" : "Checkpoint"} evidence on ${evidence.headSha.slice(0, 7)}: ${evidence.passed ? "passed" : "failed"}.`,
          ...worklog.evidenceItems.map((item) =>
            item.kind === "check"
              ? `- ${item.name} (${item.source}): ${item.timedOut ? "timed out" : `exit ${item.exitCode ?? "none"}`}${item.exitCode === 0 && !item.timedOut ? "" : item.logTail.trim().length > 0 ? `\n\`\`\`\n${tail(item.logTail.trimEnd(), EVIDENCE_TAIL_LIMIT)}\n\`\`\`` : ""}`
              : `- ${item.name}: ${item.unavailable === null ? "captured" : `not captured (${item.unavailable.text})`}`,
          ),
          ...evidence.flags.map(
            (flag) => `- Flag${flag.hard ? " (needs a person)" : ""}: ${flag.kind} ${flag.path}${flag.detail.length > 0 ? `: ${flag.detail}` : ""}`,
          ),
        ].join("\n");

  const landing = card.landing;
  const feedback =
    landing === null
      ? []
      : activities
          .filter(
            (activity) =>
              activity.createdAt >= landing.linkedAt &&
              (activity.author.kind === "github" || activity.reason?.code === "ciFailed"),
          )
          .slice(-5)
          .map((activity) => `- ${name(activity)}: ${oneLine(activity.body, 400)}`);
  const pullRequest =
    landing === null
      ? ""
      : [
          landing.mode === "local"
            ? "Lands by a local fast-forward once a person approves the merge."
            : `Pull request${landing.number === null ? "" : ` #${landing.number}`}${landing.draft ? " (draft)" : ""}: ${landing.url ?? "not opened yet"}`,
          ...(feedback.length === 0 ? [] : ["Latest feedback:", ...feedback]),
        ].join("\n");

  const changes =
    input.diff.trim().length === 0
      ? "No changes yet."
      : [
          `\`\`\`diff\n${input.diff.trimEnd()}\n\`\`\``,
          input.diffTruncated ? "The diff was cut short; run `git diff` in the worktree for the rest." : "",
        ]
          .filter((part) => part.length > 0)
          .join("\n\n");

  const build = (withDigest: boolean, messageBudget: number | null): Array<Section> => {
    const renderedMessages = renderMessages(withDigest);
    return [
      { title: "Restarted", body: worklog.restarts > 0 ? RESTART_INTRO : "" },
      { title: "Acceptance criteria", body: criteria },
      { title: "Premise", body: premise },
      { title: "Spec", body: card.spec.trim().length === 0 ? "No spec yet." : card.spec.trim() },
      { title: "Plan", body: plan },
      { title: "Decisions", body: decisions.length === 0 ? "No decisions recorded yet." : decisions },
      { title: "Questions and answers", body: questions },
      {
        title: "Messages",
        body: messageBudget === null ? renderedMessages : tail(renderedMessages, messageBudget),
      },
      { title: "Last evidence", body: evidenceBody },
      { title: "Pull request", body: pullRequest },
      {
        title: "Project rules",
        body: worklog.projectRules === null ? "" : worklog.projectRules.slice(0, PROJECT_RULES_LIMIT),
      },
      { title: "Changes so far", body: changes },
      { title: "Question", body: input.question ?? "" },
    ].filter((section) => section.body.trim().length > 0);
  };
  const size = (sections: ReadonlyArray<Section>) =>
    sections.reduce((total, section) => total + section.title.length + section.body.length + 8, 0);

  // Over the limit: the digest of older messages goes first, then the oldest recent messages.
  const full = build(true, null);
  if (size(full) <= CARD_WORKLOG_LIMIT) return full;
  const noDigest = build(false, null);
  if (size(noDigest) <= CARD_WORKLOG_LIMIT) return noDigest;
  const messagesSize = noDigest.find((section) => section.title === "Messages")?.body.length ?? 0;
  return build(false, Math.max(0, messagesSize - (size(noDigest) - CARD_WORKLOG_LIMIT)));
}

/** Builds the handoff brief a card session starts from. Pure: the caller loads the log and diff. */
export function buildCardBrief(input: CardBriefInput): CardBriefPayload {
  const { agent, card } = input;
  const diffTruncated = input.diff.length > CARD_BRIEF_DIFF_LIMIT;
  const diff = diffTruncated ? input.diff.slice(0, CARD_BRIEF_DIFF_LIMIT) : input.diff;
  const decisions =
    input.worklog === undefined
      ? input.decisions.map((decision) => ({
          authorName: authorName(decision.author, input.agents),
          text: decision.text,
          createdAt: decision.createdAt,
        }))
      : input.worklog.activities
          .filter((activity) => activity.kind === "decision")
          .map((activity) => ({
            authorName: activityAuthorName(activity.author, input.agents).replace(/^@/, ""),
            text: activity.body,
            createdAt: activity.createdAt,
          }));
  return {
    agent: { id: agent.id, name: agent.name, rolePrompt: agent.rolePrompt },
    role: input.role,
    card: {
      id: card.id,
      title: card.title,
      spec: card.spec,
      branch: card.branch,
      baseBranch: input.baseBranch,
    },
    decisions,
    diff,
    diffTruncated,
    question: input.question,
    ...(input.worklog === undefined
      ? {}
      : {
          sections: worklogSections({
            card,
            agents: input.agents,
            worklog: input.worklog,
            diff,
            diffTruncated,
            question: input.question,
          }),
        }),
  };
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

const RESTART_INTRO =
  "Your previous session on this card ended before the work was done. This worklog is everything recorded since; check the worktree's state before you continue.";

/** Renders a brief into the exact text sent to the provider. */
export function renderCardBrief(brief: CardBriefPayload): RenderedRunContext {
  const { card } = brief;
  const intro =
    brief.role === "owner"
      ? `You are @${brief.agent.name}, the agent building the card "${card.title}". You work in its worktree and are the only agent writing to it. Use the board tools: record_decision for each choice that matters, update_plan as you go, ask_owner when the spec leaves you stuck (offer two or three answers and recommend one), run_checks to run the checks (never the full suite in your shell), request_checkpoint before a costly direction, propose_card for work outside this card, propose_criteria_change when the criteria are wrong, and request_review with a summary and your risk claims once your work is committed. Iskra runs the checks and captures evidence; the card enters review only when they pass.`
      : brief.role === "verifier"
        ? `You are @${brief.agent.name}, verifying the card "${card.title}" at one commit, in a detached checkout you can read but not change. Judge each automated acceptance criterion from the evidence and the diff, say whether the diff does what the criteria ask, and decide whether each hidden scenario holds. Then call record_verdict once. You never see how the builder reasoned; judge the work, not its intentions.`
        : brief.role === "critic" && brief.question !== null
          ? `You are @${brief.agent.name}, critiquing the work on the card "${card.title}" for the agent building it. You can read its worktree but not change it. List concrete problems against the acceptance criteria, or say plainly that you found none; your critique goes to the builder.`
          : brief.role === "critic"
            ? `You are @${brief.agent.name}, reviewing the spec of the card "${card.title}" before any work starts. You can read the repository but not change it. List concrete gaps, ambiguities and risks in the spec, or say plainly that it is ready.`
            : `You are @${brief.agent.name}, helping on the card "${card.title}". You can read its worktree but not change it; your answer goes to the agent building the card.`;
  const systemPrompt = [intro, brief.agent.rolePrompt.trim()]
    .filter((part) => part.length > 0)
    .join("\n\n");

  const where =
    card.branch === null
      ? `Based on \`${card.baseBranch}\`; the card has no branch yet.`
      : `Branch \`${card.branch}\`, based on \`${card.baseBranch}\`.`;

  if (brief.sections !== undefined) {
    return {
      systemPrompt,
      firstMessage: [
        `# Handoff brief: ${card.title}`,
        where,
        ...brief.sections.map((entry) => section(entry.title, entry.body)),
      ].join("\n\n"),
    };
  }

  const decisions =
    brief.decisions.length === 0
      ? "No decisions recorded yet."
      : brief.decisions
          .map((decision) => `- [${decision.createdAt}] ${decision.authorName}: ${decision.text}`)
          .join("\n");
  const changes =
    brief.diff.trim().length === 0
      ? "No changes yet."
      : [
          `\`\`\`diff\n${brief.diff.trimEnd()}\n\`\`\``,
          brief.diffTruncated
            ? "The diff was cut short; run `git diff` in the worktree for the rest."
            : "",
        ]
          .filter((part) => part.length > 0)
          .join("\n\n");
  const firstMessage = [
    `# Handoff brief: ${card.title}`,
    where,
    section("Spec", card.spec.trim().length === 0 ? "No spec yet." : card.spec.trim()),
    section("Decisions", decisions),
    section("Changes so far", changes),
    brief.question === null ? "" : section("Question", brief.question),
  ];
  return {
    systemPrompt,
    firstMessage: firstMessage.filter((part) => part.length > 0).join("\n\n"),
  };
}

/**
 * Loads what a card's worklog is built from: its activities, its latest evidence, and the rules in
 * the root of `root` (the card's worktree, or the project's root before it has one).
 */
export const loadCardWorklog = Effect.fn("loadCardWorklog")(function* (input: {
  readonly card: OrchestrationCard;
  readonly root: string;
  readonly restarts: number;
}) {
  const cards = yield* ProjectionCardRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const activities = yield* cards.listActivities({ cardId: input.card.id, limit: 200 });
  const evidenceItems =
    input.card.evidence === null
      ? []
      : yield* cards.listEvidenceItems({
          cardId: input.card.id,
          evidenceId: input.card.evidence.evidenceId,
        });
  const rules: Array<string> = [];
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const text = yield* fileSystem
      .readFileString(path.join(input.root, file))
      .pipe(Effect.orElseSucceed(() => ""));
    if (text.trim().length > 0) rules.push(`### ${file}\n\n${text.trim()}`);
  }
  return {
    activities,
    evidenceItems,
    projectRules: rules.length === 0 ? null : rules.join("\n\n"),
    restarts: input.restarts,
  } satisfies CardWorklogInput;
});

/** Counts files and changed lines in a unified diff. */
export function diffStatOf(diff: string): CardDiffStat {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files += 1;
    } else if (line.startsWith("+") && !line.startsWith("+++ ")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("--- ")) {
      deletions += 1;
    }
  }
  return { files, additions, deletions };
}

/** Card activities waiting for the builder, as the text of its next turn. */
export function renderCardActivities(
  activities: ReadonlyArray<Pick<CardActivity, "activityId" | "author" | "body" | "createdAt">>,
  agents: ReadonlyArray<OrchestrationAgent>,
): string {
  return activities
    .map((activity) =>
      renderNewMessage({
        messageId: MessageId.make(activity.activityId),
        authorKind:
          activity.author.kind === "agent"
            ? "agent"
            : activity.author.kind === "system"
              ? "system"
              : activity.author.kind === "human" || activity.author.kind === "linear"
                ? "human"
                : "webhook",
        authorName: activityAuthorName(activity.author, agents).replace(/^@/, ""),
        body: activity.body,
        createdAt: activity.createdAt,
      }),
    )
    .join("\n\n");
}
