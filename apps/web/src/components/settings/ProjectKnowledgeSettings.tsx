import type { AtomCommandResult } from "@iskra/client-runtime/state/runtime";
import type { ProjectLesson } from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { channelEnvironment } from "~/state/channels";
import { useEnvironmentCards } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import type { Project } from "~/types";
import { StatusPill } from "../iskra/StatusPill";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { SettingsEmptyRow, SettingsRow, SettingsSection } from "./settingsLayout";

const KIND_LABEL: Record<ProjectLesson["kind"], string> = {
  quirk: "Quirk",
  playbook: "Playbook",
};

/**
 * What agents learned about the project. An agent only proposes a lesson; a person approves it
 * into agents' briefs (for cards touching its paths), dismisses it, or removes an approved one.
 */
export function ProjectKnowledgeSettings(props: { readonly project: Project }) {
  const { project } = props;
  const approve = useAtomCommand(channelEnvironment.approveLesson);
  const dismiss = useAtomCommand(channelEnvironment.dismissLesson);
  const remove = useAtomCommand(channelEnvironment.removeLesson);
  const cards = useEnvironmentCards(project.environmentId);
  const [busy, setBusy] = useState(false);
  const lessons = project.knowledge ?? [];
  const proposed = lessons.filter((lesson) => lesson.state === "proposed");
  const approved = lessons.filter((lesson) => lesson.state === "approved");

  const decide = async (
    request: Promise<AtomCommandResult<unknown, unknown>>,
    failure: string,
  ): Promise<void> => {
    setBusy(true);
    toastCommandFailure(await request, failure, "The request was refused.");
    setBusy(false);
  };
  const input = (lesson: ProjectLesson) => ({
    environmentId: project.environmentId,
    input: { projectId: project.id, lessonId: lesson.lessonId },
  });

  const row = (lesson: ProjectLesson) => {
    const source = cards.find((card) => card.id === lesson.sourceCardId);
    return (
      <li key={lesson.lessonId} className="flex min-w-0 flex-col gap-1 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusPill label={KIND_LABEL[lesson.kind]} tone="gray" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {lesson.paths.length === 0 ? "Every card" : lesson.paths.join(", ")}
            {source !== undefined ? (
              <>
                {" · from "}
                <Link
                  to="/board/$environmentId/$projectId"
                  params={{ environmentId: project.environmentId, projectId: project.id }}
                  search={{ card: source.id }}
                  className="hover:underline"
                >
                  {source.title}
                </Link>
              </>
            ) : null}
          </span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm">{lesson.text}</p>
        <div className="flex flex-wrap gap-1.5">
          {lesson.state === "proposed" ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void decide(approve(input(lesson)), "The lesson was not approved")}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void decide(dismiss(input(lesson)), "The lesson was not dismissed")}
              >
                Dismiss
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={busy}
              onClick={() => void decide(remove(input(lesson)), "The lesson was not removed")}
            >
              Remove
            </Button>
          )}
        </div>
      </li>
    );
  };

  return (
    <SettingsSection id="project-knowledge" title="Knowledge">
      <SettingsRow
        title="Proposed"
        description="Lessons agents proposed while working. Approve the ones worth telling every agent that works on these paths."
      >
        {proposed.length === 0 ? null : (
          <ul className="flex flex-col divide-y divide-border pb-3">{proposed.map(row)}</ul>
        )}
      </SettingsRow>
      {proposed.length === 0 ? <SettingsEmptyRow>Nothing proposed.</SettingsEmptyRow> : null}
      <SettingsRow
        title="Approved"
        description="Lessons agents get in their brief. A lesson reaches cards touching its paths; one without paths goes to every card."
      >
        {approved.length === 0 ? null : (
          <ul className="flex flex-col divide-y divide-border pb-3">{approved.map(row)}</ul>
        )}
      </SettingsRow>
      {approved.length === 0 ? <SettingsEmptyRow>No approved lessons yet.</SettingsEmptyRow> : null}
    </SettingsSection>
  );
}
