import type { ChannelId, EnvironmentId, ProjectId } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PROJECT_RAIL_MEMORY,
  railClickTarget,
  rememberRailRoute,
  resolveRailProject,
  routeProjectId,
  withStoredProjectFirst,
} from "./projectRail.logic";

const env = "env-1" as EnvironmentId;
const otherEnv = "env-2" as EnvironmentId;
const a = { environmentId: env, id: "a" as ProjectId };
const b = { environmentId: env, id: "b" as ProjectId };
const c = { environmentId: otherEnv, id: "c" as ProjectId };
const projects = [a, b, c];
const ch = (id: string) => id as ChannelId;

describe("routeProjectId", () => {
  const lists = {
    channels: [{ id: "ch-b", projectId: b.id }],
    agents: [{ id: "ag-b", projectId: b.id }],
    cards: [{ id: "card-b", projectId: b.id }],
    threadProjectId: null,
  };

  it("reads the project from the board, channel, agent, card or thread the route names", () => {
    expect(routeProjectId({ ...lists, params: { projectId: "a" } })).toBe("a");
    expect(routeProjectId({ ...lists, params: { channelId: "ch-b" } })).toBe("b");
    expect(routeProjectId({ ...lists, params: { agentId: "ag-b" } })).toBe("b");
    expect(routeProjectId({ ...lists, params: { cardId: "card-b" } })).toBe("b");
    expect(routeProjectId({ ...lists, params: {}, threadProjectId: b.id })).toBe("b");
  });

  it("is unresolved while the named entity has not loaded", () => {
    expect(routeProjectId({ ...lists, params: { channelId: "ch-new" } })).toBeNull();
    expect(routeProjectId({ ...lists, params: {} })).toBeNull();
  });
});

describe("resolveRailProject", () => {
  it("follows the route over the remembered project", () => {
    expect(
      resolveRailProject({
        projects,
        routeEnvironmentId: env,
        routeProjectId: b.id,
        storedProjectKey: "env-2:c",
      }),
    ).toEqual({ project: b, fromRoute: true });
  });

  it("matches the route's environment, not only the project id", () => {
    expect(
      resolveRailProject({
        projects,
        routeEnvironmentId: otherEnv,
        routeProjectId: b.id,
        storedProjectKey: null,
      }),
    ).toEqual({ project: a, fromRoute: false });
  });

  it("keeps the remembered project on routes naming none, or while the route's data loads", () => {
    expect(
      resolveRailProject({
        projects,
        routeEnvironmentId: null,
        routeProjectId: null,
        storedProjectKey: "env-2:c",
      }),
    ).toEqual({ project: c, fromRoute: false });
  });

  it("falls back to the first project when nothing is remembered or it is gone", () => {
    const resolve = (storedProjectKey: string | null) =>
      resolveRailProject({
        projects,
        routeEnvironmentId: null,
        routeProjectId: null,
        storedProjectKey,
      }).project;
    expect(resolve(null)).toBe(a);
    expect(resolve("env-1:deleted")).toBe(a);
    expect(
      resolveRailProject({
        projects: [],
        routeEnvironmentId: null,
        routeProjectId: null,
        storedProjectKey: null,
      }).project,
    ).toBeNull();
  });
});

describe("rememberRailRoute", () => {
  it("records the project and its open channel", () => {
    const memory = rememberRailRoute(EMPTY_PROJECT_RAIL_MEMORY, "env-1:b", ch("ch-b"));
    expect(memory).toEqual({
      lastProjectKey: "env-1:b",
      lastChannelByProject: { "env-1:b": "ch-b" },
    });
    const next = rememberRailRoute(memory, "env-1:a", null);
    expect(next).toEqual({
      lastProjectKey: "env-1:a",
      lastChannelByProject: { "env-1:b": "ch-b" },
    });
  });

  it("returns the same memory when nothing changed, so it is not rewritten", () => {
    const memory = rememberRailRoute(EMPTY_PROJECT_RAIL_MEMORY, "env-1:b", ch("ch-b"));
    expect(rememberRailRoute(memory, "env-1:b", ch("ch-b"))).toBe(memory);
    expect(rememberRailRoute(memory, "env-1:b", null)).toBe(memory);
  });
});

describe("railClickTarget", () => {
  it("reopens the project's last channel, else its first, else its board", () => {
    const channels = [ch("one"), ch("two")];
    expect(railClickTarget(channels, "two")).toEqual({ kind: "channel", channelId: "two" });
    expect(railClickTarget(channels, "archived")).toEqual({ kind: "channel", channelId: "one" });
    expect(railClickTarget(channels, undefined)).toEqual({ kind: "channel", channelId: "one" });
    expect(railClickTarget([], "two")).toEqual({ kind: "board" });
  });
});

describe("withStoredProjectFirst", () => {
  it("moves the remembered project first and leaves the order alone otherwise", () => {
    expect(withStoredProjectFirst(projects, "env-1:b")).toEqual([b, a, c]);
    expect(withStoredProjectFirst(projects, "env-1:gone")).toBe(projects);
  });
});
