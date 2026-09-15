import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // What each agent's runs cost a project each month (UTC), by run role.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_spend_monthly (
      project_id TEXT NOT NULL,
      month TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      cost_usd REAL NOT NULL,
      PRIMARY KEY (project_id, month, agent_id, role)
    )
  `;

  // Before this, only card sessions were priced; their turns count as the owner's.
  yield* sql`
    INSERT INTO projection_spend_monthly (project_id, month, agent_id, role, cost_usd)
    SELECT cards.project_id, substr(spend.recorded_at, 1, 7), spend.agent_id, 'owner', SUM(spend.cost_usd)
    FROM projection_card_spend AS spend
    JOIN projection_cards AS cards ON cards.card_id = spend.card_id
    GROUP BY cards.project_id, substr(spend.recorded_at, 1, 7), spend.agent_id
  `;
});
