import { wikiAuthorLabel } from "@iskra/client-runtime/card-face";
import type { EnvironmentId, ProjectId } from "@iskra/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { ScrollView, View } from "react-native";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { Body, Group, Muted, Row } from "./components";
import { channelEnvironment, useEnvironmentAgents } from "./state";

type WikiParams = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

type WikiPageParams = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly slug: string;
}>;

/** Who wrote a revision and when, as one line under a page's title. */
function editedBy(
  author: Parameters<typeof wikiAuthorLabel>[0],
  at: string,
  agentName: (agentId: string) => string | undefined,
) {
  return `Edited by ${wikiAuthorLabel(author, agentName)} · ${new Date(at).toLocaleString()}`;
}

/** A project's wiki on mobile: the pages agents and people keep, read-only. */
export function WikiRouteScreen(props: WikiParams) {
  const navigation = useNavigation();
  const environmentId = props.route.params.environmentId as EnvironmentId;
  const projectId = props.route.params.projectId as ProjectId;
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === projectId,
  );
  const agents = useEnvironmentAgents(environmentId);
  const wiki = useEnvironmentQuery(
    channelEnvironment.projectWiki({ environmentId, input: { projectId } }),
  );
  const agentName = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name;
  const pages = wiki.data?.pages ?? [];
  const changes = wiki.data?.changes ?? [];

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: project?.title ?? "Wiki" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-4 py-3"
      >
        <Group
          title="Pages"
          footer="Agents write these as they work. Open Iskra on a computer to edit or lock a page."
        >
          {pages.length === 0 ? (
            <Row first>
              <Muted>{wiki.isPending ? "Loading…" : "No pages yet."}</Muted>
            </Row>
          ) : (
            pages.map((page, index) => (
              <Row
                key={page.slug}
                first={index === 0}
                onPress={() =>
                  navigation.navigate("IskraWikiPage", {
                    environmentId,
                    projectId,
                    slug: page.slug,
                  })
                }
              >
                <Body strong>{page.title}</Body>
                <Muted lines={2}>{editedBy(page.updatedBy, page.updatedAt, agentName)}</Muted>
              </Row>
            ))
          )}
        </Group>
        <Group title="Recent changes">
          {changes.length === 0 ? (
            <Row first>
              <Muted>Nothing yet.</Muted>
            </Row>
          ) : (
            changes.map((change, index) => (
              <Row key={`${change.kind}:${change.slug}:${change.revision}`} first={index === 0}>
                <Body>
                  {change.kind === "delete" ? "Deleted " : ""}
                  {change.title}
                  {change.kind === "delete" ? "" : ` · revision ${change.revision}`}
                </Body>
                <Muted lines={2}>
                  {`${wikiAuthorLabel(change.author, agentName)} · ${new Date(change.at).toLocaleString()}${
                    change.summary.length === 0 ? "" : ` · ${change.summary}`
                  }`}
                </Muted>
              </Row>
            ))
          )}
        </Group>
      </ScrollView>
    </View>
  );
}

/** One wiki page, as its Markdown source; mobile reads the wiki and never writes it. */
export function WikiPageRouteScreen(props: WikiPageParams) {
  const environmentId = props.route.params.environmentId as EnvironmentId;
  const projectId = props.route.params.projectId as ProjectId;
  const { slug } = props.route.params;
  const agents = useEnvironmentAgents(environmentId);
  const page = useEnvironmentQuery(
    channelEnvironment.projectWikiPage({ environmentId, input: { projectId, slug } }),
  );
  const agentName = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name;
  const current = page.data?.page ?? null;

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: current?.title ?? "Page" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 px-4 py-3"
      >
        {current === null ? (
          <Muted>{page.isPending ? "Loading…" : (page.error ?? "This page is gone.")}</Muted>
        ) : (
          <>
            <Muted>{editedBy(current.updatedBy, current.updatedAt, agentName)}</Muted>
            {current.locked ? <Muted>Locked: agents can't change this page.</Muted> : null}
            <Body>{current.body}</Body>
          </>
        )}
      </ScrollView>
    </View>
  );
}
