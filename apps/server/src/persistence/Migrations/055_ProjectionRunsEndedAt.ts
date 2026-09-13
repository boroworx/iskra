import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A run is live until its session stops or fails.
  yield* sql`
    ALTER TABLE projection_runs ADD COLUMN ended_at TEXT
  `;
});
