import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@iskra/client-runtime/state/runtime";
import { projectOrchestrationOf, type ProjectId } from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { useEnvironmentCards, useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { SparkGlyph } from "../iskra/SparkGlyph";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { createSampleProject } from "./sampleProject";

const STORAGE_KEY = "iskra:guided-first-run:project";

const readStored = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

/**
 * A first run through the whole loop on a bundled sample project: create it, review its
 * side-effect guard, open its seeded card, approve and start it, watch it reach review, and approve
 * the merge. Each step ticks from the project's real state; nothing here is stored but which
 * project the guide follows.
 */
export function GuidedFirstRun() {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const cards = useEnvironmentCards(environmentId);
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const [projectId, setProjectId] = useState<string | null>(readStored);
  // The server makes an iskra-sample folder inside this one, which must exist.
  const [parentDir, setParentDir] = useState("~");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runCreateSample = useAtomCommand(createSampleProject, { reportFailure: false });

  const project = projects.find(
    (entry) => entry.environmentId === environmentId && entry.id === projectId,
  );
  // The seeded card is the project's first card; the guide follows it to landing.
  const card = useMemo(
    () =>
      cards
        .filter((entry) => entry.projectId === projectId && entry.parentCardId === null)
        .toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0],
    [cards, projectId],
  );
  const guardDone =
    project !== undefined &&
    projectOrchestrationOf(project).sideEffectGuard.acknowledgedAt !== null;
  const started = card !== undefined && card.status !== "triage" && card.delegateAgentId !== null;
  const reviewed =
    card !== undefined &&
    (card.status === "inReview" || card.status === "landing" || card.status === "landed");
  const landed = card?.status === "landed";

  const create = async () => {
    if (environmentId === null) return;
    setCreating(true);
    setError(null);
    const result = await runCreateSample({ environmentId, input: { parentDir: parentDir.trim() } });
    setCreating(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "The sample project couldn't be created.",
        );
      }
      return;
    }
    setProjectId(result.value.projectId);
    try {
      window.localStorage.setItem(STORAGE_KEY, result.value.projectId);
    } catch {
      // The guide still follows the project for this visit.
    }
  };

  const boardLink = (label: string) =>
    environmentId === null || project === undefined || card === undefined ? null : (
      <Button
        size="sm"
        variant="outline"
        render={
          <Link
            to="/board/$environmentId/$projectId"
            params={{ environmentId, projectId: project.id as ProjectId }}
            search={{ card: card.id }}
          />
        }
      >
        {label}
      </Button>
    );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          <h1 className="truncate text-[15px] font-semibold">Guided first run</h1>
        </WorkspacePageHeader>
        <main className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <div className="mx-auto flex max-w-xl flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Take one card from proposal to landed on a small sample app with a failing test. It
              takes a few minutes and a little agent spend.
            </p>
            <ol className="flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card shadow-[0_0_0_0.5px_var(--border)]">
              <Step
                done={project !== undefined}
                title="Create the sample project"
                tip="A new git repository with its checks and three agents: a lead, a builder and a verifier."
              >
                {project === undefined ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Input
                      size="sm"
                      className="w-56"
                      aria-label="Folder to create it in"
                      value={parentDir}
                      onChange={(event) => setParentDir(event.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={creating || parentDir.trim().length === 0 || environmentId === null}
                      onClick={() => void create()}
                    >
                      Create sample project
                    </Button>
                  </div>
                ) : null}
                {error !== null ? (
                  <p className="text-xs text-destructive-foreground">{error}</p>
                ) : null}
              </Step>
              <Step
                done={guardDone}
                title="Review its side-effect guard"
                tip="Agents never start on a project until a person checks what its code could do to real accounts."
              >
                {project !== undefined && !guardDone ? (
                  <Button
                    size="sm"
                    variant="outline"
                    render={
                      <Link
                        to="/settings/projects"
                        search={{ project: deriveLogicalProjectKeyFromSettings(project, grouping) }}
                        hash="project-side-effect-guard"
                      />
                    }
                  >
                    Review side-effect guard
                  </Button>
                ) : null}
              </Step>
              <Step
                done={started}
                title="Open the seeded card and Approve & start"
                tip="Approving confirms its acceptance criteria and picks the agent that owns it."
              >
                {guardDone && !started ? boardLink("Open the card") : null}
              </Step>
              <Step
                done={reviewed}
                title="Watch it reach review"
                tip="The builder fixes the test; Iskra runs the checks, and the verifier when it's on, before it asks you."
              >
                {started && !reviewed ? boardLink("Watch the card") : null}
              </Step>
              <Step
                done={landed}
                title="Approve the merge"
                tip="Only a person approves a merge. Review shows the evidence for each criterion first."
              >
                {reviewed && !landed ? boardLink("Review and approve") : null}
              </Step>
            </ol>
            {landed ? (
              <p className="flex items-center gap-2 text-sm">
                <SparkGlyph state="landed" /> Landed. That's the whole loop.
              </p>
            ) : null}
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

function Step(props: {
  readonly done: boolean;
  readonly title: string;
  readonly tip: string;
  readonly children?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 gap-3 px-4 py-3">
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
          props.done ? "bg-success text-white" : "shadow-[inset_0_0_0_1.5px_var(--border)]",
        )}
      >
        {props.done ? <CheckIcon className="size-3" /> : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className={cn("text-sm font-medium", props.done && "text-muted-foreground")}>
          {props.title}
        </span>
        {!props.done ? <p className="text-xs text-muted-foreground">{props.tip}</p> : null}
        {props.children}
      </div>
    </li>
  );
}
