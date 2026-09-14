import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as LinearClient from "./LinearClient.ts";

const issueNode = {
  id: "issue-1",
  identifier: "ENG-1",
  url: "https://linear.app/acme/issue/ENG-1",
  title: "Rate limit the API",
  description: null,
  updatedAt: "2026-02-01T00:00:02.000Z",
  team: { id: "team-eng" },
  state: { id: "state-todo", type: "unstarted" },
  delegate: { id: "user-iskra" },
  comments: {
    nodes: [
      { id: "c2", body: "Per key.", createdAt: "2026-02-01T00:00:02.000Z", user: null },
      {
        id: "c1",
        body: "Which limit?",
        createdAt: "2026-02-01T00:00:01.000Z",
        user: { id: "user-ana", name: "Ana" },
      },
    ],
  },
};

const makeClient = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
    const stored: Array<string> = [];
    const http = HttpClient.make((request) => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      const body = request.url.endsWith("/oauth/token")
        ? { access_token: "token-1", expires_in: 2_591_999 }
        : { data: { issues: { nodes: [issueNode] } } };
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
        ),
      );
    });
    const client = yield* LinearClient.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: () => Effect.succeed(Option.none()),
            set: (_name, value) => Effect.sync(() => void stored.push(new TextDecoder().decode(value))),
          }),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        ),
      ),
    );
    return { client, requests, stored };
  });

it.effect("signs in as the app once, keeps the token, and reads issues with it", () =>
  Effect.gen(function* () {
    const { client, requests, stored } = yield* makeClient({
      ISKRA_LINEAR_CLIENT_ID: "client",
      ISKRA_LINEAR_CLIENT_SECRET: "secret",
    });
    expect(client.configured).toBe(true);

    const found = yield* client.issuesByIds(["issue-1"]);
    yield* client.issuesByIds(["issue-1"]);

    expect(found).toEqual([
      {
        id: "issue-1",
        identifier: "ENG-1",
        url: "https://linear.app/acme/issue/ENG-1",
        teamId: "team-eng",
        title: "Rate limit the API",
        description: "",
        updatedAt: "2026-02-01T00:00:02.000Z",
        stateId: "state-todo",
        stateType: "unstarted",
        delegateId: "user-iskra",
        comments: [
          {
            id: "c1",
            body: "Which limit?",
            createdAt: "2026-02-01T00:00:01.000Z",
            authorId: "user-ana",
            authorName: "Ana",
          },
          {
            id: "c2",
            body: "Per key.",
            createdAt: "2026-02-01T00:00:02.000Z",
            authorId: null,
            authorName: "Linear",
          },
        ],
      },
    ]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.linear.app/oauth/token",
      "https://api.linear.app/graphql",
      "https://api.linear.app/graphql",
    ]);
    expect(requests[1]?.authorization).toBe("Bearer token-1");
    expect(stored[0]).toContain('"accessToken":"token-1"');
  }),
);

it.effect("stays unconfigured, and makes no request, without the app's credentials", () =>
  Effect.gen(function* () {
    const { client, requests } = yield* makeClient({});
    expect(client.configured).toBe(false);
    const error = yield* client.viewerId.pipe(Effect.flip);
    expect(error.message).toContain("Linear is not set up");
    expect(requests).toEqual([]);
  }),
);
