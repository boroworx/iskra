import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The agent a channel message that mentions no one wakes.
  yield* sql`ALTER TABLE projection_channels ADD COLUMN lead_agent_id TEXT`;
  // The channel message a lead proposed a card from.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN source_message_id TEXT`;
});
