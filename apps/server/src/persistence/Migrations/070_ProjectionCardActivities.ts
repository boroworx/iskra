import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A card's one activity stream: messages, decisions, questions, status moves and evidence.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_card_activities (
      activity_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      author_json TEXT NOT NULL,
      body TEXT NOT NULL,
      run_thread_id TEXT,
      deliver_to TEXT,
      delivery_status TEXT,
      delivery_thread_id TEXT,
      elicitation_json TEXT,
      answers_json TEXT,
      status_json TEXT,
      evidence_id TEXT,
      reason_json TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_card_activities_card
    ON projection_card_activities (card_id, created_at)
  `;

  // Backfill what the card projections already hold, shaped as the projection writes it, so a
  // replay of the events and this backfill agree. The old tables stay as they are.
  yield* sql`
    INSERT OR IGNORE INTO projection_card_activities (
      activity_id, card_id, kind, author_json, body, run_thread_id, deliver_to, delivery_status,
      delivery_thread_id, created_at
    )
    SELECT
      message_id,
      card_id,
      'message',
      json_object('kind', author_kind, 'id', author_id),
      body,
      run_thread_id,
      CASE WHEN delivery_status IS NULL THEN NULL ELSE 'builder' END,
      delivery_status,
      delivery_thread_id,
      created_at
    FROM projection_card_messages
  `;
  // A lead's decision is an agent's in the activity stream.
  yield* sql`
    INSERT OR IGNORE INTO projection_card_activities (
      activity_id, card_id, kind, author_json, body, created_at
    )
    SELECT
      decision_id,
      card_id,
      'decision',
      json_object(
        'kind',
        CASE json_extract(author_json, '$.kind')
          WHEN 'lead' THEN 'agent'
          ELSE json_extract(author_json, '$.kind')
        END,
        'id',
        json_extract(author_json, '$.id')
      ),
      text,
      created_at
    FROM projection_card_decisions
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_card_activities (
      activity_id, card_id, kind, author_json, body, status_json, reason_json, created_at
    )
    SELECT
      'status:' || event_id,
      json_extract(payload_json, '$.cardId'),
      'status',
      json_object('kind', 'system', 'id', 'system'),
      '',
      json_object('from', json_extract(payload_json, '$.from'), 'to', json_extract(payload_json, '$.to')),
      CASE
        WHEN json_extract(payload_json, '$.reason') IS NULL THEN NULL
        ELSE json_object(
          'code',
          json_extract(payload_json, '$.move'),
          'text',
          json_extract(payload_json, '$.reason')
        )
      END,
      json_extract(payload_json, '$.updatedAt')
    FROM orchestration_events
    WHERE event_type = 'card.status-changed'
  `;

  // A lead's question with options on a channel message, the answer a person's message gives,
  // and the channel's questions still open.
  yield* sql`ALTER TABLE projection_channel_messages ADD COLUMN elicitation_json TEXT`;
  yield* sql`ALTER TABLE projection_channel_messages ADD COLUMN answers_json TEXT`;
  yield* sql`ALTER TABLE projection_channel_messages ADD COLUMN answered_at TEXT`;
  yield* sql`ALTER TABLE projection_channels ADD COLUMN open_elicitations_json TEXT`;
});
