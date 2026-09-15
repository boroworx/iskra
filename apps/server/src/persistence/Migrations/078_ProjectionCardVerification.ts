import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A card's verification; null reads as off, as every card from before the verifier is.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN verification_json TEXT`;

  // Each verdict a verifier recorded. Hidden scenarios are ids and results only, never their text.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_card_verdicts (
      verdict_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      verifier_json TEXT NOT NULL,
      criteria_json TEXT NOT NULL,
      diff_judge_json TEXT NOT NULL,
      scenarios_json TEXT NOT NULL,
      passed INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_card_verdicts_card_recorded
    ON projection_card_verdicts (card_id, recorded_at)
  `;
});
