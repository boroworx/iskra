import type { SparkState } from "@iskra/client-runtime/card-face";
import type { EnvironmentProject } from "@iskra/client-runtime/state/shell";
import type { AgentPresence, EnvironmentId } from "@iskra/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { ScrollView, View } from "react-native";

import { useProjects } from "../../state/entities";
import { AgentAvatar, Body, Group, Muted, Row } from "./components";
import { useEnvironmentAgents, useEnvironmentChannels } from "./state";

export const PRESENCE_SPARK: Record<AgentPresence, SparkState> = {
  running: "working",
  blocked: "needsYou",
  idle: "idle",
};

/** Every project's board, channels and agent DMs, one grouped list per project. */
export function ChannelsRouteScreen() {
  const projects = useProjects();
  const byEnvironment = useMemo(() => {
    const groups = new Map<EnvironmentId, EnvironmentProject[]>();
    for (const project of projects) {
      groups.set(project.environmentId, [...(groups.get(project.environmentId) ?? []), project]);
    }
    return [...groups.entries()];
  }, [projects]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerClassName="gap-6 px-4 pt-3 pb-10"
    >
      {byEnvironment.length === 0 ? (
        <View className="items-center py-16">
          <Muted>No projects yet. Add one from an environment.</Muted>
        </View>
      ) : null}
      {byEnvironment.map(([environmentId, environmentProjects]) => (
        <EnvironmentChannels
          key={environmentId}
          environmentId={environmentId}
          projects={environmentProjects}
        />
      ))}
    </ScrollView>
  );
}

function EnvironmentChannels(props: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}) {
  const navigation = useNavigation();
  const channels = useEnvironmentChannels(props.environmentId);
  const agents = useEnvironmentAgents(props.environmentId);
  const { environmentId } = props;
  return (
    <>
      {props.projects.map((project) => {
        // The filter's copy is sorted in place: Hermes has no Array#toSorted.
        const projectChannels = channels
          .filter((channel) => channel.projectId === project.id && channel.kind === "channel")
          .sort((left, right) => left.name.localeCompare(right.name));
        const projectAgents = agents
          .filter((agent) => agent.projectId === project.id)
          .sort((left, right) => left.name.localeCompare(right.name));
        return (
          <Group key={project.id} title={project.title}>
            <Row first onPress={() => navigation.navigate("IskraBoard", { environmentId, projectId: project.id })}>
              <Body>Board</Body>
            </Row>
            {projectChannels.map((channel) => (
              <Row
                key={channel.id}
                onPress={() => navigation.navigate("IskraChannel", { environmentId, channelId: channel.id })}
              >
                <View className="flex-row items-center gap-2">
                  <Body># {channel.name}</Body>
                  {channel.topic.length > 0 ? <Muted lines={1}>{channel.topic}</Muted> : null}
                </View>
              </Row>
            ))}
            {projectAgents.map((agent) => (
              <Row
                key={agent.id}
                onPress={() => navigation.navigate("IskraAgentDm", { environmentId, agentId: agent.id })}
              >
                <View className="flex-row items-center gap-3">
                  <AgentAvatar name={agent.name} spark={PRESENCE_SPARK[agent.presence]} size={24} />
                  <Body>@{agent.name}</Body>
                </View>
              </Row>
            ))}
          </Group>
        );
      })}
    </>
  );
}
