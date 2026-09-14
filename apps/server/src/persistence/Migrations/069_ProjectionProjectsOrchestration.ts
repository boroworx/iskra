import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A project's orchestration policy; null until a person sets one, and read as the defaults.
  yield* sql`ALTER TABLE projection_projects ADD COLUMN orchestration_json TEXT`;
});
