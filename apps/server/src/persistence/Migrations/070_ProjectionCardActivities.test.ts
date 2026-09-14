import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@iskra/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("070_ProjectionCardActivities", (it) => {
  it.effect("backfills a card's messages, decisions and status moves into its activity stream", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });

      yield* sql`
        INSERT INTO projection_card_messages (
          message_id, card_id, author_kind, author_id, body, run_thread_id, delivery_status,
          delivery_thread_id, created_at
        )
        VALUES
          ('message-1', 'card-1', 'human', 'human', 'Also cap bursts.', NULL, 'sent', 'thread-1',
            '2026-03-01T00:01:00.000Z'),
          ('message-2', 'card-1', 'agent', 'agent-1', 'Done.', 'thread-1', NULL, NULL,
            '2026-03-01T00:03:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_card_decisions (decision_id, card_id, author_json, text, created_at)
        VALUES
          ('card-1:lead-reasoning', 'card-1', '{"kind":"lead","id":"agent-lead"}', 'Asked for.',
            '2026-03-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id,
          causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-return', 'card', 'card-1', 0, 'card.status-changed', '2026-03-01T00:02:00.000Z',
          NULL, NULL, NULL, 'server',
          '{"cardId":"card-1","from":"inReview","to":"inProgress","move":"returnToWork","reason":"Checks failed.","updatedAt":"2026-03-01T00:02:00.000Z"}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 70 });

      const rows = yield* sql<{
        readonly activityId: string;
        readonly kind: string;
        readonly author: string;
        readonly body: string;
        readonly runThreadId: string | null;
        readonly deliverTo: string | null;
        readonly delivery: string | null;
        readonly deliveryThreadId: string | null;
        readonly status: string | null;
        readonly reason: string | null;
      }>`
        SELECT
          activity_id AS "activityId",
          kind,
          author_json AS "author",
          body,
          run_thread_id AS "runThreadId",
          deliver_to AS "deliverTo",
          delivery_status AS "delivery",
          delivery_thread_id AS "deliveryThreadId",
          status_json AS "status",
          reason_json AS "reason"
        FROM projection_card_activities
        WHERE card_id = 'card-1'
        ORDER BY created_at ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          activityId: "card-1:lead-reasoning",
          kind: "decision",
          author: '{"kind":"agent","id":"agent-lead"}',
          body: "Asked for.",
          runThreadId: null,
          deliverTo: null,
          delivery: null,
          deliveryThreadId: null,
          status: null,
          reason: null,
        },
        {
          activityId: "message-1",
          kind: "message",
          author: '{"kind":"human","id":"human"}',
          body: "Also cap bursts.",
          runThreadId: null,
          deliverTo: "builder",
          delivery: "sent",
          deliveryThreadId: "thread-1",
          status: null,
          reason: null,
        },
        {
          activityId: "status:event-return",
          kind: "status",
          author: '{"kind":"system","id":"system"}',
          body: "",
          runThreadId: null,
          deliverTo: null,
          delivery: null,
          deliveryThreadId: null,
          status: '{"from":"inReview","to":"inProgress"}',
          reason: '{"code":"returnToWork","text":"Checks failed."}',
        },
        {
          activityId: "message-2",
          kind: "message",
          author: '{"kind":"agent","id":"agent-1"}',
          body: "Done.",
          runThreadId: "thread-1",
          deliverTo: null,
          delivery: null,
          deliveryThreadId: null,
          status: null,
          reason: null,
        },
      ]);
      // The old tables are left as they were.
      const [{ messages }] = yield* sql<{ readonly messages: number }>`
        SELECT COUNT(*) AS messages FROM projection_card_messages
      `;
      assert.strictEqual(messages, 2);
    }),
  );
});
