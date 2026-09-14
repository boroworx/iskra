import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Why a channel's lead proposed a card, shown to the person triaging it.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN proposal_reasoning TEXT`;
});
