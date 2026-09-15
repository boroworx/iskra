import type { PillTone } from "@iskra/client-runtime/card-face";
import {
  PLAN_CHILD_STATE_LABEL,
  planDraftLine,
  planSlices,
  type PlanChildState,
} from "@iskra/client-runtime/plan-view";
import type { EnvironmentId, OrchestrationCardShell } from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { cardEnvironment } from "~/state/cards";
import { useAtomCommand } from "~/state/use-atom-command";
import { StatusPill } from "../iskra/StatusPill";
import { toastCommandFailure } from "../toastCommandFailure";
import { Textarea } from "../ui/textarea";
import { ActionButton, Group, Row, Section, Trail } from "./cardChrome";

const CHILD_TONE: Record<PlanChildState, PillTone> = {
  proposed: "gray",
  needsAgent: "orange",
  held: "gray",
  blocked: "gray",
  queued: "gray",
  working: "blue",
  review: "orange",
  landed: "green",
  abandoned: "gray",
};

/**
 * A plan card's plan: its children as cards grouped by slice, what each depends on, and, while a
 * revision waits, Approve plan or Redirect. After approval each child follows its own card.
 */
export function PlanReview(props: {
  readonly card: OrchestrationCardShell;
  readonly cards: ReadonlyArray<OrchestrationCardShell>;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const plan = card.plan;
  const approve = useAtomCommand(cardEnvironment.approvePlan);
  const answer = useAtomCommand(cardEnvironment.answerElicitation);
  const [note, setNote] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [sending, setSending] = useState(false);
  const slices = useMemo(
    () => (plan === null ? [] : planSlices(card.id, plan, props.cards)),
    [card.id, plan, props.cards],
  );
  if (plan === null) return null;
  const question = card.openElicitations.find((open) => open.kind === "plan");
  const children = slices.flatMap((slice) => slice.children);
  const landed = children.filter((view) => view.state === "landed").length;

  const approvePlan = async () => {
    setSending(true);
    const result = await approve({
      environmentId,
      input: { cardId: card.id, revision: plan.revision },
    });
    setSending(false);
    toastCommandFailure(result, "The plan was not approved", "The request was refused.");
  };
  const redirect = async () => {
    if (question === undefined) return;
    setSending(true);
    const result = await answer({
      environmentId,
      input: {
        cardId: card.id,
        activityId: question.activityId,
        optionId: "redirect",
        body: note.trim(),
      },
    });
    setSending(false);
    toastCommandFailure(result, "The redirect was not sent", "The request was refused.");
    if (result._tag === "Success") {
      setNote("");
      setRedirecting(false);
    }
  };

  return (
    <>
      <Section
        label="Plan"
        trailing={
          <span className="truncate tabular-nums">
            {plan.state === "drafting"
              ? planDraftLine(card.status)
              : plan.state === "proposed"
                ? `Revision ${plan.revision}, waiting for your approval`
                : `Revision ${plan.revision} approved · ${landed} of ${children.length} landed`}
            {plan.integrationBranch !== null ? ` · lands into ${plan.integrationBranch}` : ""}
          </span>
        }
      >
        {plan.premise.trim().length > 0 ? (
          <p className="whitespace-pre-wrap break-words px-4 text-[13px]">{plan.premise}</p>
        ) : null}
      </Section>
      {slices.map((slice) => (
        <Section
          key={slice.slice}
          label={`Slice ${slice.slice}${
            plan.state === "approved" && slice.slice > plan.currentSlice
              ? " · waits for the checkpoint"
              : slice.finished
                ? " · finished"
                : ""
          }`}
        >
          <Group>
            {slice.children.map((view) => (
              <Row key={view.child.key} className="py-2.5">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {view.cardId === null ? (
                    <span className="truncate font-medium">{view.child.title}</span>
                  ) : (
                    <Link
                      to="/board/$environmentId/$projectId"
                      params={{ environmentId, projectId: card.projectId }}
                      search={{ card: view.cardId }}
                      className="truncate font-medium hover:underline"
                    >
                      {view.child.title}
                    </Link>
                  )}
                  <span className="truncate text-xs text-tertiary-label">
                    {view.child.criteria.length} criteri
                    {view.child.criteria.length === 1 ? "on" : "a"}
                    {view.child.suggestedAgent !== null
                      ? ` · @${view.child.suggestedAgent}`
                      : " · no agent suggested"}
                    {view.dependsOnTitles.length > 0
                      ? ` · after ${view.dependsOnTitles.join(", ")}`
                      : ""}
                  </span>
                </span>
                <Trail>
                  <StatusPill
                    label={PLAN_CHILD_STATE_LABEL[view.state]}
                    tone={CHILD_TONE[view.state]}
                  />
                </Trail>
              </Row>
            ))}
          </Group>
        </Section>
      ))}
      {plan.state === "proposed" ? (
        <div className="flex flex-col gap-2">
          {redirecting ? (
            <Textarea
              aria-label="What the coordinator should change"
              placeholder="What the coordinator should change in the plan"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {redirecting ? (
              <>
                <ActionButton
                  disabled={sending}
                  onClick={() => {
                    setRedirecting(false);
                    setNote("");
                  }}
                >
                  Cancel
                </ActionButton>
                <ActionButton
                  disabled={sending || note.trim().length === 0 || question === undefined}
                  onClick={() => void redirect()}
                >
                  Send redirect
                </ActionButton>
              </>
            ) : (
              <ActionButton
                disabled={sending || question === undefined}
                onClick={() => setRedirecting(true)}
              >
                Redirect…
              </ActionButton>
            )}
            <ActionButton tone="primary" disabled={sending} onClick={() => void approvePlan()}>
              Approve plan
            </ActionButton>
          </div>
        </div>
      ) : null}
    </>
  );
}
