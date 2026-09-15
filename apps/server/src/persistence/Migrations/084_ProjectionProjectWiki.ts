import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const PathsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodePaths = Schema.decodeSync(PathsJson);
const encodePaths = Schema.encodeSync(PathsJson);

/** WIKI_PAGE_BODY_MAX_CHARS when this migration was written. */
const BODY_MAX_CHARS = 20_000;
/** A person approved these lessons, so their pages read as written by a person. */
const IMPORTED_BY = '{"kind":"human","agentId":null,"cardId":null}';

interface LessonRow {
  readonly projectId: string;
  readonly kind: string;
  readonly text: string;
  readonly pathsJson: string;
  readonly at: string;
}

interface ImportedPage {
  readonly projectId: string;
  readonly slug: string;
  readonly title: string;
  readonly paths: ReadonlyArray<string>;
  lines: Array<string>;
  size: number;
  at: string;
}

const slugWords = (paths: ReadonlyArray<string>) =>
  paths
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A project's wiki: each page at its latest revision, and every revision it had.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_project_wiki_pages (
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by_json TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (project_id, slug)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_project_wiki_revisions (
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      author_json TEXT NOT NULL,
      restored_from INTEGER,
      written_at TEXT NOT NULL,
      PRIMARY KEY (project_id, slug, revision)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_project_wiki_revisions_recent
    ON projection_project_wiki_revisions (project_id, written_at)
  `;

  // The wiki replaces lessons. Approved lessons become pages, one per set of paths; path-less
  // lessons went to every card, so their page is about `**`. Proposed and dismissed ones end here.
  const lessons = yield* sql<LessonRow>`
    SELECT
      project_id AS "projectId",
      kind,
      text,
      paths_json AS "pathsJson",
      COALESCE(decided_at, created_at) AS "at"
    FROM projection_project_knowledge
    WHERE state = 'approved'
    ORDER BY created_at ASC, rowid ASC
  `;
  const pages = new Map<string, ImportedPage>();
  const slugs = new Set<string>();
  for (const lesson of lessons) {
    const lessonPaths = decodePaths(lesson.pathsJson).toSorted();
    const key = `${lesson.projectId}\n${lessonPaths.join("\n")}`;
    let page = pages.get(key);
    if (page === undefined) {
      const base = slugWords(lessonPaths).length === 0 ? "lessons" : `lessons-${slugWords(lessonPaths)}`;
      let slug = base;
      for (let n = 2; slugs.has(`${lesson.projectId}\n${slug}`); n += 1) slug = `${base}-${n}`;
      slugs.add(`${lesson.projectId}\n${slug}`);
      page = {
        projectId: lesson.projectId,
        slug,
        title: lessonPaths.length === 0 ? "Lessons" : `Lessons: ${lessonPaths.join(", ")}`,
        paths: lessonPaths.length === 0 ? ["**"] : lessonPaths,
        lines: [],
        size: 0,
        at: lesson.at,
      };
      pages.set(key, page);
    }
    const line = `- ${lesson.kind === "quirk" ? "Quirk" : "Playbook"}: ${lesson.text}`;
    if (page.size + line.length + 1 > BODY_MAX_CHARS) continue;
    page.lines.push(line);
    page.size += line.length + 1;
    if (lesson.at > page.at) page.at = lesson.at;
  }
  for (const page of pages.values()) {
    const body = page.lines.join("\n");
    const pathsJson = encodePaths(page.paths);
    yield* sql`
      INSERT INTO projection_project_wiki_pages (
        project_id, slug, title, body, paths_json, locked, revision, updated_at, updated_by_json, deleted_at
      )
      VALUES (${page.projectId}, ${page.slug}, ${page.title}, ${body}, ${pathsJson}, 0, 1, ${page.at}, ${IMPORTED_BY}, NULL)
      ON CONFLICT (project_id, slug) DO NOTHING
    `;
    yield* sql`
      INSERT INTO projection_project_wiki_revisions (
        project_id, slug, revision, title, body, paths_json, summary, author_json, restored_from, written_at
      )
      VALUES (
        ${page.projectId}, ${page.slug}, 1, ${page.title}, ${body}, ${pathsJson},
        'Approved lessons from before the wiki', ${IMPORTED_BY}, NULL, ${page.at}
      )
      ON CONFLICT (project_id, slug, revision) DO NOTHING
    `;
  }
  yield* sql`DROP TABLE IF EXISTS projection_project_knowledge`;
});
