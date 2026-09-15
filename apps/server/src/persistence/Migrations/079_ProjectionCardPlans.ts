import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Where a card came from, a plan's or migration's state, and a child's place in its plan.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN origin_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN plan_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN migration_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN plan_key TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN slice INTEGER`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN held_by_checkpoint INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN unattended INTEGER NOT NULL DEFAULT 0`;

  // Origins read from who created each card, as cardOriginOf does: an attempt or a builder's
  // sub-card is its owner's work.
  yield* sql`
    UPDATE projection_cards
    SET origin_json = CASE
      WHEN attempt_group_id IS NOT NULL THEN json_object('kind', 'owner', 'id', NULL)
      WHEN json_extract(created_by_json, '$.kind') = 'agent'
        THEN json_object('kind', 'owner', 'id', json_extract(created_by_json, '$.id'))
      WHEN json_extract(created_by_json, '$.kind') = 'lead'
        THEN json_object('kind', 'lead', 'id', json_extract(created_by_json, '$.id'))
      WHEN json_extract(created_by_json, '$.kind') = 'linear'
        THEN json_object('kind', 'linear', 'id', json_extract(created_by_json, '$.id'))
      ELSE json_object('kind', 'human', 'id', NULL)
    END
  `;
  // A plan card from before plans is still drafting one.
  yield* sql`
    UPDATE projection_cards
    SET plan_json = '{"state":"drafting","revision":0,"proposalActivityId":null,"premise":"","children":[],"integrationBranch":null,"currentSlice":1,"approvedAt":null}'
    WHERE kind = 'plan'
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_cards_parent_card
    ON projection_cards (parent_card_id)
  `;
});
