import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  agentDmThreadId,
  type EnvironmentId,
  type OrchestrationAgentShell,
} from "@iskra/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useThreadShells } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Opens an agent's DM: its one continuous thread, created on first open with
 * the agent's model. Every later open returns to the same conversation.
 */
export function useOpenAgentDm() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const createThread = useAtomCommand(threadEnvironment.create);

  return useCallback(
    async (
      environmentId: EnvironmentId,
      agent: Pick<OrchestrationAgentShell, "id" | "projectId" | "name" | "modelSelection">,
    ) => {
      const threadId = agentDmThreadId(agent.id);
      const exists = threads.some(
        (thread) => thread.environmentId === environmentId && thread.id === threadId,
      );
      if (!exists) {
        const created = await createThread({
          environmentId,
          input: {
            threadId,
            projectId: agent.projectId,
            title: `@${agent.name}`,
            modelSelection: agent.modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
          },
        });
        if (created._tag !== "Success") {
          return;
        }
      }
      await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    },
    [createThread, navigate, threads],
  );
}
