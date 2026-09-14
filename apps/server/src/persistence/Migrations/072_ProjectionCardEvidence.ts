import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Each captured item of a card's evidence, keyed by the recording and the item within it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_card_evidence (
      evidence_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      purpose TEXT NOT NULL,
      criterion_id TEXT,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      exit_code INTEGER,
      timed_out INTEGER NOT NULL,
      duration_ms INTEGER,
      log_tail TEXT NOT NULL,
      artifact_path TEXT,
      unavailable_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (evidence_id, item_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_card_evidence_card
    ON projection_card_evidence (card_id, created_at)
  `;
});
