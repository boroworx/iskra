import { assert, it } from "@effect/vitest";
import {
  AgentId,
  CARD_VERIFICATION_OFF,
  CardId,
  DEFAULT_AGENT_BLUEPRINT,
  DEFAULT_AGENT_ROLES,
  ProviderInstanceId,
  type CardVerdict,
} from "@iskra/contracts";
import * as NodeSqliteClient from "@iskra/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionAgentRepositoryLive } from "../Layers/ProjectionAgents.ts";
import { ProjectionCardRepositoryLive } from "../Layers/ProjectionCards.ts";
import { runMigrations } from "../Migrations.ts";
import { ProjectionAgentRepository } from "../Services/ProjectionAgents.ts";
import { ProjectionCardRepository } from "../Services/ProjectionCards.ts";

const layer = it.layer(
  Layer.mergeAll(ProjectionCardRepositoryLive, ProjectionAgentRepositoryLive).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

layer("078_ProjectionCardVerification", (it) => {
  it.effect("reads cards and agents from before the verifier as its defaults, and keeps each verdict once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      yield* sql`
        INSERT INTO projection_cards (
          card_id, project_id, title, spec, spec_state, tags_json, status, owner_human_id,
          relations_json, created_by_json, activity_at, created_at, updated_at
        )
        VALUES ('card-1', 'project-1', 'Limits', '', 'approved', '[]', 'inReview', 'human', '[]',
          '{"kind":"human","id":"human"}', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z',
          '2026-03-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_agents (
          agent_id, project_id, name, avatar, role_tags_json, role_prompt, model_selection_json,
          capabilities_json, created_at, updated_at, archived_at
        )
        VALUES ('agent-1', 'project-1', 'api', NULL, '[]', '',
          '{"instanceId":"claudeAgent","model":"claude-sonnet-5"}', '["read"]',
          '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL)
      `;
      yield* runMigrations({ toMigrationInclusive: 78 });

      const cards = yield* ProjectionCardRepository;
      const agents = yield* ProjectionAgentRepository;
      const cardId = CardId.make("card-1");
      const card = yield* cards.getById({ cardId });
      assert.deepStrictEqual(
        Option.map(card, (row) => row.verification),
        Option.some(CARD_VERIFICATION_OFF),
      );
      const agent = yield* agents.getById({ agentId: AgentId.make("agent-1") });
      assert.deepStrictEqual(
        Option.map(agent, (row) => [row.roles, row.verifyWith, row.blueprint]),
        Option.some([DEFAULT_AGENT_ROLES, null, DEFAULT_AGENT_BLUEPRINT]),
      );

      const verdict = (verdictId: string, passed: boolean, recordedAt: string): CardVerdict => ({
        verdictId,
        cardId,
        headSha: "abc1234",
        verifier: {
          agentId: AgentId.make("agent-1"),
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
          reason: { code: "differentProvider", text: "OpenCode checks Claude's work." },
        },
        criteria: [{ criterionId: "c1", pass: passed, evidence: "limits.test.ts", note: "" }],
        diffJudge: { matchesCriteria: true, concerns: [] },
        scenarios: [{ scenarioId: "holdout-1", satisfied: passed }],
        passed,
        recordedAt,
      });
      assert.deepStrictEqual(yield* cards.latestVerdict({ cardId }), Option.none());
      yield* cards.appendVerdict(verdict("verdict-1", false, "2026-03-01T00:01:00.000Z"));
      yield* cards.appendVerdict(verdict("verdict-2", true, "2026-03-01T00:02:00.000Z"));
      yield* cards.appendVerdict(verdict("verdict-2", false, "2026-03-01T00:03:00.000Z"));
      assert.deepStrictEqual(
        yield* cards.latestVerdict({ cardId }),
        Option.some(verdict("verdict-2", true, "2026-03-01T00:02:00.000Z")),
      );
    }),
  );
});
