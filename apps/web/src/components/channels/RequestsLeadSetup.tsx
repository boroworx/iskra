import type { EnvironmentProject } from "@iskra/client-runtime/state/models";
import {
  REQUESTS_CHANNEL_NAME,
  requestsChannelId,
  type AgentId,
  type AgentRole,
  type OrchestrationAgentShell,
  type OrchestrationChannelShell,
} from "@iskra/contracts";
import { useMemo, useState } from "react";

import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { agentListEntries, leadCandidates } from "./channels.logic";
import { CreateAgentDialog } from "./CreateAgentDialog";

const LEAD_ROLES: ReadonlyArray<AgentRole> = ["lead"];

/**
 * Inside Requests while it has no lead: pick an agent that may lead, or create one. Setting the
 * lead creates Requests the first time, with every agent of the project as a member.
 */
export function RequestsLeadSetup(props: {
  readonly project: EnvironmentProject;
  /** Null until Requests is created. */
  readonly channel: OrchestrationChannelShell | null;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
}) {
  const { environmentId, id: projectId } = props.project;
  const createChannel = useAtomCommand(channelEnvironment.create);
  const updateChannel = useAtomCommand(channelEnvironment.update);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(
    () => leadCandidates(props.agents, projectId, null),
    [props.agents, projectId],
  );

  const setLead = async (leadAgentId: AgentId) => {
    setBusy(true);
    const update = () =>
      updateChannel({
        environmentId,
        input: { channelId: requestsChannelId(projectId), leadAgentId },
      });
    let result =
      props.channel === null
        ? await createChannel({
            environmentId,
            input: {
              channelId: requestsChannelId(projectId),
              projectId,
              kind: "requests",
              name: REQUESTS_CHANNEL_NAME,
              // A just-created lead may not be in the agent list yet.
              memberAgentIds: [
                ...new Set([
                  ...agentListEntries(props.agents, projectId).map((agent) => agent.id),
                  leadAgentId,
                ]),
              ],
              leadAgentId,
            },
          })
        : await update();
    // Another tab may have created Requests first; then setting its lead is an update.
    if (props.channel === null && result._tag === "Failure") {
      const updated = await update();
      if (updated._tag === "Success") result = updated;
    }
    setBusy(false);
    toastCommandFailure(result, "The lead was not set", "The request was refused.");
  };

  return (
    <section className="rounded-[12px] bg-muted px-4 py-3.5">
      <h2 className="text-[15px] font-semibold">Choose who turns requests into cards</h2>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        It asks what's unclear, then proposes cards for you to approve.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {candidates.length === 0 ? (
          <Button size="sm" disabled={busy} onClick={() => setCreatingAgent(true)}>
            Create a lead agent
          </Button>
        ) : (
          <>
            <Menu>
              <MenuTrigger render={<Button size="sm" disabled={busy} />}>Choose a lead</MenuTrigger>
              <MenuPopup align="start" className="min-w-52">
                {candidates.map((agent) => (
                  <MenuItem key={agent.id} onClick={() => void setLead(agent.id)}>
                    @{agent.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => setCreatingAgent(true)}
            >
              Create a lead agent
            </Button>
          </>
        )}
      </div>
      <CreateAgentDialog
        open={creatingAgent}
        onOpenChange={setCreatingAgent}
        project={props.project}
        initialName="lead"
        initialRoles={LEAD_ROLES}
        onCreated={(agentId) => void setLead(agentId)}
      />
    </section>
  );
}
