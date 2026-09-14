import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@iskra/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("074_ProjectionCardQuestions", (it) => {
  it.effect("gives questions a kind and opens each open card's unanswered ones", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });

      yield* sql`
        INSERT INTO projection_cards (
          card_id, project_id, title, spec, spec_state, tags_json, status, owner_human_id,
          relations_json, created_by_json, created_at, updated_at
        )
        VALUES
          ('card-1', 'project-1', 'Limits', '', 'approved', '[]', 'inProgress', 'human', '[]',
            '{"kind":"human","id":"human"}', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
          ('card-2', 'project-1', 'Done', '', 'approved', '[]', 'landed', 'human', '[]',
            '{"kind":"human","id":"human"}', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_card_activities (
          activity_id, card_id, kind, author_json, body, elicitation_json, answers_json, reason_json,
          created_at
        )
        VALUES
          ('ask-owner:1', 'card-1', 'elicitation', '{"kind":"agent","id":"agent-1"}', 'Which store?',
            '{"question":"Which store?","options":[{"id":"o1","label":"Redis"},{"id":"o2","label":"Memory"}],"recommendedOptionId":"o1","allowText":true}',
            NULL, NULL, '2026-03-01T00:01:00.000Z'),
          ('ask-owner:2', 'card-1', 'elicitation', '{"kind":"agent","id":"agent-1"}', 'Per key?',
            NULL, NULL, NULL, '2026-03-01T00:02:00.000Z'),
          ('ask-owner:2:answer', 'card-1', 'response', '{"kind":"human","id":"human"}', 'Yes.',
            NULL, '{"questionId":"ask-owner:2","optionId":null}', NULL, '2026-03-01T00:03:00.000Z'),
          ('checkpoint-1', 'card-1', 'elicitation', '{"kind":"system","id":"system"}', 'Try it.',
            '{"question":"Right way?","options":[{"id":"continue","label":"Continue"}],"recommendedOptionId":"continue","allowText":true}',
            NULL, NULL, '2026-03-01T00:04:00.000Z'),
          ('criteria-change-1', 'card-2', 'elicitation', '{"kind":"agent","id":"agent-1"}', 'Change?',
            '{"question":"Change?","options":[{"id":"apply","label":"Apply"}],"recommendedOptionId":null,"allowText":true}',
            NULL, '{"code":"criteriaChange","text":"Wrong."}', '2026-03-01T00:05:00.000Z')
      `;
      yield* runMigrations({ toMigrationInclusive: 74 });

      const kinds = yield* sql<{ readonly id: string; readonly kind: string | null }>`
        SELECT activity_id AS id, json_extract(elicitation_json, '$.kind') AS kind
        FROM projection_card_activities WHERE kind = 'elicitation' ORDER BY activity_id
      `;
      assert.deepStrictEqual(kinds, [
        { id: "ask-owner:1", kind: "question" },
        { id: "ask-owner:2", kind: null },
        { id: "checkpoint-1", kind: "checkpoint" },
        { id: "criteria-change-1", kind: "criteriaChange" },
      ]);
      const cards = yield* sql<{ readonly id: string; readonly open: string | null }>`
        SELECT card_id AS id, open_elicitations_json AS open FROM projection_cards ORDER BY card_id
      `;
      assert.deepStrictEqual(
        cards.map((card) => [card.id, card.open === null ? null : JSON.parse(card.open)]),
        [
          [
            "card-1",
            [
              {
                activityId: "ask-owner:1",
                kind: "question",
                optionIds: ["o1", "o2"],
                askedAt: "2026-03-01T00:01:00.000Z",
              },
              {
                activityId: "checkpoint-1",
                kind: "checkpoint",
                optionIds: ["continue"],
                askedAt: "2026-03-01T00:04:00.000Z",
              },
            ],
          ],
          ["card-2", null],
        ],
      );
    }),
  );
});
