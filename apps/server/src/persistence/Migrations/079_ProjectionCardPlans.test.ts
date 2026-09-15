import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@iskra/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-03-01T00:00:00.000Z";

it.layer(NodeSqliteClient.layerMemory())("079_ProjectionCardPlans", (it) => {
  it.effect("reads each card's origin from who created it, and a plan card from before plans as drafting", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      const insert = (cardId: string, createdBy: string, kind = "task", attemptGroupId: string | null = null) =>
        sql`
          INSERT INTO projection_cards (
            card_id, project_id, title, spec, spec_state, tags_json, status, owner_human_id,
            relations_json, created_by_json, activity_at, created_at, updated_at, kind, attempt_group_id
          )
          VALUES (${cardId}, 'project-1', 'Limits', '', 'draft', '[]', 'triage', 'human', '[]',
            ${createdBy}, ${at}, ${at}, ${at}, ${kind}, ${attemptGroupId})
        `;
      yield* insert("card-human", '{"kind":"human","id":"human"}');
      yield* insert("card-lead", '{"kind":"lead","id":"agent-lead"}');
      yield* insert("card-sub", '{"kind":"agent","id":"agent-builder"}');
      yield* insert("card-attempt", '{"kind":"human","id":"human"}', "task", "attempts:1");
      yield* insert("card-linear", '{"kind":"linear","id":"ISK-12"}');
      yield* insert("card-plan", '{"kind":"human","id":"human"}', "plan");
      yield* runMigrations({ toMigrationInclusive: 79 });

      const rows = yield* sql<{
        readonly cardId: string;
        readonly origin: string;
        readonly plan: string | null;
        readonly heldByCheckpoint: number;
        readonly unattended: number;
      }>`
        SELECT card_id AS "cardId", origin_json AS "origin", plan_json AS "plan",
          held_by_checkpoint AS "heldByCheckpoint", unattended
        FROM projection_cards
        ORDER BY card_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.cardId, JSON.parse(row.origin), row.heldByCheckpoint, row.unattended]),
        [
          ["card-attempt", { kind: "owner", id: null }, 0, 0],
          ["card-human", { kind: "human", id: null }, 0, 0],
          ["card-lead", { kind: "lead", id: "agent-lead" }, 0, 0],
          ["card-linear", { kind: "linear", id: "ISK-12" }, 0, 0],
          ["card-plan", { kind: "human", id: null }, 0, 0],
          ["card-sub", { kind: "owner", id: "agent-builder" }, 0, 0],
        ],
      );
      assert.deepStrictEqual(
        rows.map((row) => (row.plan === null ? null : JSON.parse(row.plan).state)),
        [null, null, null, null, "drafting", null],
      );
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("081_ProjectionSpendMonthly", (it) => {
  it.effect("sums each card session's spend into its project's month as the owner's", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      const card = (cardId: string, projectId: string) =>
        sql`
          INSERT INTO projection_cards (
            card_id, project_id, title, spec, spec_state, tags_json, status, owner_human_id,
            relations_json, created_by_json, activity_at, created_at, updated_at
          )
          VALUES (${cardId}, ${projectId}, 'Limits', '', 'draft', '[]', 'triage', 'human', '[]',
            '{"kind":"human","id":"human"}', ${at}, ${at}, ${at})
        `;
      const spend = (spendId: string, cardId: string, agentId: string, costUsd: number, recordedAt: string) =>
        sql`
          INSERT INTO projection_card_spend (
            spend_id, card_id, agent_id, thread_id, cost_usd, cost_source, recorded_at
          )
          VALUES (${spendId}, ${cardId}, ${agentId}, 'thread-1', ${costUsd}, 'reported', ${recordedAt})
        `;
      yield* card("card-1", "project-1");
      yield* card("card-2", "project-2");
      yield* spend("s1", "card-1", "agent-a", 1, "2026-01-10T00:00:00.000Z");
      yield* spend("s2", "card-1", "agent-a", 2, "2026-01-20T00:00:00.000Z");
      yield* spend("s3", "card-1", "agent-b", 0.5, "2026-02-01T00:00:00.000Z");
      yield* spend("s4", "card-2", "agent-a", 4, "2026-01-05T00:00:00.000Z");
      // Spend of a card whose row is gone has no project to count toward.
      yield* spend("s5", "card-missing", "agent-a", 9, "2026-01-05T00:00:00.000Z");
      yield* runMigrations({ toMigrationInclusive: 81 });

      const rows = yield* sql<{
        readonly projectId: string;
        readonly month: string;
        readonly agentId: string;
        readonly role: string;
        readonly costUsd: number;
      }>`
        SELECT project_id AS "projectId", month, agent_id AS "agentId", role, cost_usd AS "costUsd"
        FROM projection_spend_monthly
        ORDER BY project_id, month, agent_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.projectId, row.month, row.agentId, row.role, row.costUsd]),
        [
          ["project-1", "2026-01", "agent-a", "owner", 3],
          ["project-1", "2026-02", "agent-b", "owner", 0.5],
          ["project-2", "2026-01", "agent-a", "owner", 4],
        ],
      );
    }),
  );
});
