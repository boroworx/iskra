import {
  WIKI_PAGE_BODY_MAX_CHARS,
  type ProjectWikiPage,
  type ProjectWikiPageSummary,
} from "@iskra/contracts";

export const WIKI_BODY_EMPTY_REASON = "A wiki page needs some text.";
export const WIKI_BODY_TOO_LONG_REASON = `Keep a wiki page under ${WIKI_PAGE_BODY_MAX_CHARS} characters; split a long one into smaller pages.`;
export const WIKI_RESTORE_EARLIER_REASON = "A page can only be restored to one of its own revisions.";
export const WIKI_ALREADY_LOCKED_REASON = "This wiki page is already locked.";
export const WIKI_NOT_LOCKED_REASON = "This wiki page isn't locked.";
export const WIKI_VERIFIER_READS_REASON =
  "A verifier only reads the wiki, so nothing it knows about hidden scenarios reaches pages other agents read.";
export const WIKI_CRITIC_READS_REASON =
  "A critic only reads the wiki; put what should be written down in your critique for the builder.";

export const noWikiPageReason = (slug: string) => `This project has no wiki page "${slug}".`;
export const wikiLockedReason = (slug: string) =>
  `A person locked the wiki page "${slug}", so agents can't change it. If it is wrong or out of date, ask a person to update it instead, with ask_owner on a card.`;
export const wikiPageExistsReason = (slug: string, revision: number) =>
  `A wiki page "${slug}" already exists, at revision ${revision}. Read it and update that revision instead of creating another page.`;
export const wikiStaleReason = (slug: string, expected: number, current: number) =>
  `The wiki page "${slug}" changed since revision ${expected} and is at revision ${current} now. Read it again and apply your change to the latest revision.`;
export const wikiGoneReason = (slug: string) =>
  `The wiki page "${slug}" doesn't exist anymore; write it as a new page.`;

/** A page as agents and briefs see it: a deleted page doesn't exist for them. */
export const liveWikiPage = (pages: ReadonlyArray<ProjectWikiPage> | undefined, slug: string) =>
  pages?.find((page) => page.slug === slug && page.deletedAt === null);

/**
 * Why a write to a wiki page is refused, or null. `expectedRevision` is the revision the writer
 * read, 0 to create a page; an agent can't write a page a person locked.
 */
export function wikiWriteRefusal(input: {
  readonly page: ProjectWikiPage | undefined;
  readonly slug: string;
  readonly body: string;
  readonly expectedRevision: number;
  readonly restoredFrom: number | null;
  readonly byAgent: boolean;
}): string | null {
  if (input.body.trim().length === 0) return WIKI_BODY_EMPTY_REASON;
  if (input.body.length > WIKI_PAGE_BODY_MAX_CHARS) return WIKI_BODY_TOO_LONG_REASON;
  const live = input.page?.deletedAt === null ? input.page : undefined;
  if (input.byAgent && live?.locked === true) return wikiLockedReason(input.slug);
  const current = live?.revision ?? 0;
  if (input.expectedRevision !== current) {
    return current === 0
      ? wikiGoneReason(input.slug)
      : input.expectedRevision === 0
        ? wikiPageExistsReason(input.slug, current)
        : wikiStaleReason(input.slug, input.expectedRevision, current);
  }
  if (input.restoredFrom !== null && input.restoredFrom > (input.page?.revision ?? 0)) {
    return WIKI_RESTORE_EARLIER_REASON;
  }
  return null;
}

const SNIPPET_CHARS = 160;

const snippetOf = (text: string, words: ReadonlyArray<string>) => {
  const lower = text.toLowerCase();
  const at = Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0));
  const start = Number.isFinite(at) ? Math.max(0, at - 60) : 0;
  const cut = text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${cut}${start + SNIPPET_CHARS < text.length ? "…" : ""}`;
};

/**
 * Live pages holding every word of `query` in their slug, title or text, the ones matching more
 * words in the title first, then newest. An empty query lists every live page, newest first.
 * ponytail: scans each page's text in memory; move to SQLite FTS if wikis grow past a few hundred pages.
 */
export function searchWikiPages(
  pages: ReadonlyArray<ProjectWikiPage>,
  query: string,
  limit: number | null,
): ReadonlyArray<ProjectWikiPageSummary> {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const ranked = pages
    .filter((page) => page.deletedAt === null)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .flatMap((page) => {
      const head = `${page.slug} ${page.title}`.toLowerCase();
      const body = page.body.toLowerCase();
      if (!words.every((word) => head.includes(word) || body.includes(word))) return [];
      return [{ page, inTitle: words.filter((word) => head.includes(word)).length }];
    })
    .toSorted((a, b) => b.inTitle - a.inTitle);
  return (limit === null ? ranked : ranked.slice(0, limit)).map(
    ({ page: { body, deletedAt: _deletedAt, ...summary } }) => ({
      ...summary,
      snippet: words.length === 0 ? null : snippetOf(body, words),
    }),
  );
}
