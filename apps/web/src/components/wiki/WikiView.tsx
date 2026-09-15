import { wikiAuthorLabel } from "@iskra/client-runtime/card-face";
import type {
  EnvironmentId,
  ProjectId,
  ProjectWikiChange,
  ProjectWikiPageSummary,
} from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon, LockIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentAgents, useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { EmptyState, PageColumn, PageLargeTitle } from "../iskra/Page";
import { StatusPill } from "../iskra/StatusPill";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/** A page being written: a new one when `creating`, otherwise the revision it is based on. */
interface Draft {
  readonly slug: string;
  readonly title: string;
  readonly paths: string;
  readonly body: string;
  readonly summary: string;
  readonly expectedRevision: number;
  readonly restoredFrom: number | null;
  readonly creating: boolean;
}

const MINUTE = 60_000;

/** How long ago, as the wiki shows it next to an author. */
function ago(at: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(at));
  if (elapsed < MINUTE) return "just now";
  if (elapsed < 60 * MINUTE) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < 48 * 60 * MINUTE) return `${Math.floor(elapsed / (60 * MINUTE))}h ago`;
  return new Date(at).toLocaleDateString();
}

const slugify = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const pathsOf = (paths: string) =>
  paths
    .split(",")
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);

const ROW = "flex min-w-0 flex-col gap-0.5 px-4 py-2.5 text-left";

/**
 * A project's wiki: what agents and people wrote down about the project. Agents write it as they
 * work; a person watches the changes here, and can edit, restore, lock or delete a page.
 */
export function WikiView(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly slug: string | null;
}) {
  const { environmentId, projectId } = props;
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === projectId,
  );
  const agents = useEnvironmentAgents(environmentId);
  const agentName = useMemo(
    () => (agentId: string) => agents.find((agent) => agent.id === agentId)?.name,
    [agents],
  );
  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  // One atom per search, so the list is only refetched once a person stops typing.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const list = useEnvironmentQuery(
    channelEnvironment.projectWiki({
      environmentId,
      input: { projectId, ...(search.length === 0 ? {} : { query: search }) },
    }),
  );
  const page = useEnvironmentQuery(
    props.slug === null
      ? null
      : channelEnvironment.projectWikiPage({
          environmentId,
          input: { projectId, slug: props.slug },
        }),
  );
  // A page an agent wrote lands in the project's shell as a new change time.
  const changedAt = project?.wikiUpdatedAt ?? null;
  useEffect(() => {
    list.refresh();
    page.refresh();
  }, [changedAt, list, page]);

  const write = useAtomCommand(channelEnvironment.writeWikiPage, { reportFailure: false });
  const lock = useAtomCommand(channelEnvironment.lockWikiPage, { reportFailure: false });
  const unlock = useAtomCommand(channelEnvironment.unlockWikiPage, { reportFailure: false });
  const remove = useAtomCommand(channelEnvironment.deleteWikiPage, { reportFailure: false });
  const readPage = useAtomCommand(channelEnvironment.getProjectWikiPage, { reportFailure: false });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const current = page.data?.page ?? null;

  const refresh = () => {
    list.refresh();
    page.refresh();
  };

  const save = async (next: Draft) => {
    const slug = next.slug.trim();
    if (slug.length === 0) {
      toastCommandFailure(
        { _tag: "Failure", cause: null } as never,
        "The page needs a name",
        "Give it a name like api-rate-limits.",
      );
      return;
    }
    setBusy(true);
    const result = await write({
      environmentId,
      input: {
        projectId,
        slug,
        title: next.title.trim(),
        body: next.body,
        paths: pathsOf(next.paths),
        summary: next.summary.trim().length === 0 ? "Edited" : next.summary.trim(),
        expectedRevision: next.expectedRevision,
        restoredFrom: next.restoredFrom,
      },
    });
    setBusy(false);
    toastCommandFailure(result, "The page was not saved", "The request was refused.");
    if (result._tag === "Success") {
      setDraft(null);
      refresh();
    }
  };

  /** Puts a page back to one of its revisions: the wiki keeps the restore as its next revision. */
  const restore = async (slug: string, revision: number) => {
    setBusy(true);
    const read = await readPage({ environmentId, input: { projectId, slug, revision } });
    setBusy(false);
    toastCommandFailure(read, "That revision didn't load", "Try again.");
    if (read._tag !== "Success" || read.value.revision === null) return;
    const source = read.value.revision;
    await save({
      slug,
      title: source.title,
      body: source.body,
      paths: source.paths.join(", "),
      summary: `Restored revision ${revision}`,
      expectedRevision: read.value.page.deletedAt === null ? read.value.page.revision : 0,
      restoredFrom: revision,
      creating: false,
    });
  };

  const confirmed = async (message: string) =>
    (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);

  const deletePage = async (slug: string) => {
    if (!(await confirmed(`Delete the wiki page "${slug}"?\nIts history stays, so you can restore it from Recent changes.`))) {
      return;
    }
    setBusy(true);
    const result = await remove({ environmentId, input: { projectId, slug } });
    setBusy(false);
    toastCommandFailure(result, "The page was not deleted", "The request was refused.");
    if (result._tag === "Success") refresh();
  };

  const setLocked = async (slug: string, locked: boolean) => {
    setBusy(true);
    const result = await (locked ? lock : unlock)({ environmentId, input: { projectId, slug } });
    setBusy(false);
    toastCommandFailure(
      result,
      locked ? "The page was not locked" : "The page was not unlocked",
      "The request was refused.",
    );
    if (result._tag === "Success") refresh();
  };

  /** Takes one change back: a written revision goes back to the one before it, a delete restores. */
  const revert = async (change: ProjectWikiChange) => {
    if (change.kind === "delete") return restore(change.slug, change.revision);
    if (change.revision === 1) return deletePage(change.slug);
    return restore(change.slug, change.revision - 1);
  };

  const wikiLink = (slug: string | null) => (
    <Link
      to="/board/$environmentId/$projectId"
      params={{ environmentId, projectId }}
      search={slug === null ? { view: "wiki" as const } : { view: "wiki" as const, page: slug }}
    />
  );

  const editor = draft === null ? null : (
    <div className="flex flex-col gap-3 rounded-[14px] bg-card p-4">
      <Input
        aria-label="Title"
        placeholder="Title"
        value={draft.title}
        onChange={(event) =>
          setDraft({
            ...draft,
            title: event.target.value,
            slug: draft.creating && draft.slug === slugify(draft.title) ? slugify(event.target.value) : draft.slug,
          })
        }
      />
      {draft.creating ? (
        <Input
          aria-label="Page name"
          placeholder="api-rate-limits"
          value={draft.slug}
          onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
        />
      ) : null}
      <Input
        aria-label="Paths"
        placeholder="Paths this page is about, such as src/api/** (** for every card)"
        value={draft.paths}
        onChange={(event) => setDraft({ ...draft, paths: event.target.value })}
      />
      <Textarea
        aria-label="Page"
        className="min-h-64 font-mono text-[13px]"
        placeholder="What later agents on this project should know."
        value={draft.body}
        onChange={(event) => setDraft({ ...draft, body: event.target.value })}
      />
      <Input
        aria-label="What changed"
        placeholder="What this edit changes"
        value={draft.summary}
        onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
      />
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void save(draft)}>
          Save
        </Button>
      </div>
    </div>
  );

  const changes = list.data?.changes ?? [];
  const pages: ReadonlyArray<ProjectWikiPageSummary> = list.data?.pages ?? [];

  const index = (
    <>
      <PageLargeTitle>Wiki</PageLargeTitle>
      <Input
        aria-label="Search the wiki"
        placeholder="Search pages"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {draft === null ? null : <div className="mt-4">{editor}</div>}
      {pages.length === 0 && draft === null ? (
        <EmptyState
          className="flex-none py-14"
          title={search.length === 0 ? "Nothing written down yet" : "No page matches"}
          body={
            search.length === 0
              ? "Agents write down what they learn about this project as they work. You can start a page yourself."
              : "Try fewer words."
          }
          actions={
            search.length === 0 ? (
              <Button
                size="sm"
                onClick={() =>
                  setDraft({
                    slug: "",
                    title: "",
                    paths: "",
                    body: "",
                    summary: "First page",
                    expectedRevision: 0,
                    restoredFrom: null,
                    creating: true,
                  })
                }
              >
                New page
              </Button>
            ) : null
          }
        />
      ) : (
        <ul className="mt-4 flex flex-col overflow-hidden rounded-xl bg-card">
          {pages.map((entry, position) => (
            <li key={entry.slug} className={cn(position > 0 && "border-t-[0.5px] border-border")}>
              <Link
                to="/board/$environmentId/$projectId"
                params={{ environmentId, projectId }}
                search={{ view: "wiki" as const, page: entry.slug }}
                className={cn(ROW, "hover:bg-accent")}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-[15px] font-semibold">{entry.title}</span>
                  {entry.locked ? <StatusPill label="Locked" tone="gray" /> : null}
                </span>
                <span className="truncate text-[13px] text-muted-foreground">
                  {entry.snippet ??
                    `${entry.paths.length === 0 ? "No paths" : entry.paths.join(", ")} · edited by ${wikiAuthorLabel(entry.updatedBy, agentName)} ${ago(entry.updatedAt, now)}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <h2 className="mt-7 px-4 text-[13px] font-semibold text-muted-foreground">Recent changes</h2>
      <ul className="mt-2 flex flex-col overflow-hidden rounded-xl bg-card">
        {changes.length === 0 ? (
          <li className={cn(ROW, "text-[13px] text-muted-foreground")}>Nothing yet.</li>
        ) : (
          changes.map((change, position) => (
            <li
              key={`${change.kind}:${change.slug}:${change.revision}`}
              className={cn(
                "flex min-w-0 items-center gap-2 px-4 py-2.5",
                position > 0 && "border-t-[0.5px] border-border",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="min-w-0 truncate text-[14px]">
                  {change.kind === "delete" ? "Deleted " : ""}
                  <Link
                    to="/board/$environmentId/$projectId"
                    params={{ environmentId, projectId }}
                    search={{ view: "wiki" as const, page: change.slug }}
                    className="font-medium hover:underline"
                  >
                    {change.title}
                  </Link>
                  {change.restoredFrom === null
                    ? ""
                    : ` · restored revision ${change.restoredFrom}`}
                </span>
                <span className="truncate text-[12px] text-tertiary-label">
                  {wikiAuthorLabel(change.author, agentName)} · {ago(change.at, now)}
                  {change.summary.length === 0 ? "" : ` · ${change.summary}`}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void revert(change)}
              >
                Revert
              </Button>
            </li>
          ))
        )}
      </ul>
    </>
  );

  const revisions = page.data?.history ?? [];
  const view =
    current === null ? (
      <EmptyState
        title={page.isPending ? "Loading" : "This page is gone"}
        body={page.error ?? "It may have been deleted; Recent changes can bring it back."}
        actions={
          <Button size="sm" variant="secondary" render={wikiLink(null)}>
            Back to the wiki
          </Button>
        }
      />
    ) : (
      <>
        <PageLargeTitle
          accessory={current.locked ? <StatusPill label="Locked" tone="gray" /> : null}
        >
          {current.title}
        </PageLargeTitle>
        <p className="text-[13px] text-muted-foreground">
          Edited by {wikiAuthorLabel(current.updatedBy, agentName)} · {ago(current.updatedAt, now)} ·
          revision {current.revision}
          {current.paths.length === 0 ? "" : ` · ${current.paths.join(", ")}`}
        </p>
        {draft === null ? (
          <div className="mt-5 min-w-0">
            <ChatMarkdown text={current.body} cwd={undefined} environmentId={environmentId} />
          </div>
        ) : (
          <div className="mt-5">{editor}</div>
        )}
        <div className="mt-6 flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setHistory((open) => !open)}
            aria-expanded={history}
          >
            {history ? "Hide history" : `History (${revisions.length})`}
          </Button>
        </div>
        {history ? (
          <ul className="mt-2 flex flex-col overflow-hidden rounded-xl bg-card">
            {revisions.map((revision, position) => (
              <li
                key={revision.revision}
                className={cn(
                  "flex min-w-0 items-center gap-2 px-4 py-2.5",
                  position > 0 && "border-t-[0.5px] border-border",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14px]">
                    Revision {revision.revision} · {revision.summary || "Edited"}
                  </span>
                  <span className="truncate text-[12px] text-tertiary-label">
                    {wikiAuthorLabel(revision.author, agentName)} · {ago(revision.writtenAt, now)}
                  </span>
                </span>
                {revision.revision === current.revision ? (
                  <span className="text-[12px] text-tertiary-label">Current</span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void restore(current.slug, revision.revision)}
                  >
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </>
    );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader>
          {props.slug === null ? (
            <span className="truncate text-[15px] font-semibold">
              {project?.title ?? "Project"} · Wiki
            </span>
          ) : (
            <Button size="sm" variant="ghost" render={wikiLink(null)}>
              <ChevronLeftIcon />
              Wiki
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {props.slug === null || current === null ? (
              <Button
                size="sm"
                disabled={draft !== null}
                onClick={() =>
                  setDraft({
                    slug: "",
                    title: "",
                    paths: "",
                    body: "",
                    summary: "First page",
                    expectedRevision: 0,
                    restoredFrom: null,
                    creating: true,
                  })
                }
              >
                <PlusIcon />
                New page
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-pressed={current.locked}
                  onClick={() => void setLocked(current.slug, !current.locked)}
                >
                  <LockIcon />
                  {current.locked ? "Unlock" : "Lock"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() => void deletePage(current.slug)}
                >
                  Delete
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={draft !== null}
                  onClick={() =>
                    setDraft({
                      slug: current.slug,
                      title: current.title,
                      paths: current.paths.join(", "),
                      body: current.body,
                      summary: "",
                      expectedRevision: current.revision,
                      restoredFrom: null,
                      creating: false,
                    })
                  }
                >
                  Edit
                </Button>
              </>
            )}
          </div>
        </WorkspacePageHeader>
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-10">
          <PageColumn width="reading" className="flex flex-col">
            {props.slug === null ? index : view}
          </PageColumn>
        </main>
      </div>
    </SidebarInset>
  );
}
