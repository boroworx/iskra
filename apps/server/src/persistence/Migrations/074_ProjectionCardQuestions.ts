import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A card's unanswered questions, so the decider and Needs you read them without its activity.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN open_elicitations_json TEXT`;

  // Questions recorded before they had a kind: a criteria change and a checkpoint say which they are.
  yield* sql`
    UPDATE projection_card_activities
    SET elicitation_json = json_set(
      elicitation_json,
      '$.kind',
      CASE
        WHEN json_extract(reason_json, '$.code') = 'criteriaChange' THEN 'criteriaChange'
        WHEN activity_id LIKE 'checkpoint-%' THEN 'checkpoint'
        ELSE 'question'
      END
    )
    WHERE kind = 'elicitation'
      AND elicitation_json IS NOT NULL
      AND json_extract(elicitation_json, '$.kind') IS NULL
  `;

  // An open card's questions without a response naming them are still open.
  yield* sql`
    UPDATE projection_cards
    SET open_elicitations_json = (
      SELECT json_group_array(
        json_object(
          'activityId', question.activity_id,
          'kind', COALESCE(
            json_extract(question.elicitation_json, '$.kind'),
            CASE WHEN question.activity_id LIKE 'checkpoint-%' THEN 'checkpoint' ELSE 'question' END
          ),
          'optionIds', json((
            SELECT json_group_array(json_extract(entry.value, '$.id'))
            FROM json_each(COALESCE(question.elicitation_json, '{}'), '$.options') AS entry
          )),
          'askedAt', question.created_at
        )
      )
      FROM projection_card_activities AS question
      WHERE question.card_id = projection_cards.card_id
        AND question.kind = 'elicitation'
        AND NOT EXISTS (
          SELECT 1
          FROM projection_card_activities AS answer
          WHERE answer.card_id = question.card_id
            AND json_extract(answer.answers_json, '$.questionId') = question.activity_id
        )
    )
    WHERE status NOT IN ('landed', 'abandoned')
  `;
});
