import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A snooze hides a card from Needs you until its time or the card's next activity.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN snoozed_until TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN snoozed_at TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN activity_at TEXT`;
  yield* sql`UPDATE projection_cards SET activity_at = updated_at WHERE activity_at IS NULL`;
  // The worktree's diff size, measured after owner turns.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN diff_stat_json TEXT`;
});
