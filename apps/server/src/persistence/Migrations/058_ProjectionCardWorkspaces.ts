import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("branch")) {
    yield* sql`
      ALTER TABLE projection_cards
      ADD COLUMN branch TEXT
    `;
  }
  if (!has("worktree_path")) {
    yield* sql`
      ALTER TABLE projection_cards
      ADD COLUMN worktree_path TEXT
    `;
  }
  if (!has("port_base")) {
    yield* sql`
      ALTER TABLE projection_cards
      ADD COLUMN port_base INTEGER
    `;
  }
});
