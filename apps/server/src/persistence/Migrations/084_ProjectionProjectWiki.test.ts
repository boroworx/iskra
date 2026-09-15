import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@iskra/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("084_ProjectionProjectWiki", (it) => {
  it.effect("turns approved lessons into wiki pages, one per set of paths, and drops the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 83 });

      yield* sql`
        INSERT INTO projection_project_knowledge (
          lesson_id, project_id, kind, text, paths_json, state, source_card_id, created_at, decided_at
        )
        VALUES
          ('l1', 'p1', 'quirk', 'Limits load at boot.', '["src/api/**"]', 'approved', 'card-1',
            '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z'),
          ('l2', 'p1', 'playbook', 'Run the migrations first.', '[]', 'approved', NULL,
            '2026-03-01T00:01:00.000Z', '2026-03-01T00:02:00.000Z'),
          ('l3', 'p1', 'playbook', 'Restart after editing limits.', '["src/api/**"]', 'approved', NULL,
            '2026-03-01T00:03:00.000Z', '2026-03-03T00:00:00.000Z'),
          ('l4', 'p1', 'quirk', 'Proposed only.', '[]', 'proposed', NULL, '2026-03-01T00:04:00.000Z', NULL),
          ('l5', 'p2', 'quirk', 'Dismissed.', '[]', 'dismissed', NULL, '2026-03-01T00:05:00.000Z',
            '2026-03-01T00:06:00.000Z')
      `;
      yield* runMigrations({ toMigrationInclusive: 84 });

      const pages = yield* sql<Record<string, unknown>>`
        SELECT project_id, slug, title, body, paths_json, locked, revision, updated_at, deleted_at
        FROM projection_project_wiki_pages ORDER BY project_id, slug
      `;
      assert.deepStrictEqual(pages, [
        {
          project_id: "p1",
          slug: "lessons",
          title: "Lessons",
          body: "- Playbook: Run the migrations first.",
          paths_json: '["**"]',
          locked: 0,
          revision: 1,
          updated_at: "2026-03-01T00:02:00.000Z",
          deleted_at: null,
        },
        {
          project_id: "p1",
          slug: "lessons-src-api",
          title: "Lessons: src/api/**",
          body: "- Quirk: Limits load at boot.\n- Playbook: Restart after editing limits.",
          paths_json: '["src/api/**"]',
          locked: 0,
          revision: 1,
          updated_at: "2026-03-03T00:00:00.000Z",
          deleted_at: null,
        },
      ]);
      const revisions = yield* sql<{ readonly slug: string; readonly revision: number; readonly summary: string }>`
        SELECT slug, revision, summary FROM projection_project_wiki_revisions ORDER BY slug
      `;
      assert.deepStrictEqual(revisions, [
        { slug: "lessons", revision: 1, summary: "Approved lessons from before the wiki" },
        { slug: "lessons-src-api", revision: 1, summary: "Approved lessons from before the wiki" },
      ]);
      const knowledge = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_project_knowledge'
      `;
      assert.deepStrictEqual(knowledge, []);
    }),
  );
});
