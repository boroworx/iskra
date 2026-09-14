import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // How many times the card's owner was restarted before this run, and why the run waits.
  // The run's session state is derived where it is read, from its session and open requests.
  yield* sql`ALTER TABLE projection_runs ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE projection_runs ADD COLUMN wait_reason_json TEXT`;
});
