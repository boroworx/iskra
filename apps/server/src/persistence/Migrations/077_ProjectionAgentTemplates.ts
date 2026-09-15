import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // What an agent template runs as, who verifies its cards and the steps it adds. Null reads as the
  // defaults, so agents from before roles keep the powers they had.
  yield* sql`ALTER TABLE projection_agents ADD COLUMN roles_json TEXT`;
  yield* sql`ALTER TABLE projection_agents ADD COLUMN verify_with TEXT`;
  yield* sql`ALTER TABLE projection_agents ADD COLUMN blueprint_json TEXT`;
});
