import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type { CardPriority } from "@iskra/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";

const API_URL = "https://api.linear.app/graphql";
const TOKEN_URL = "https://api.linear.app/oauth/token";
// Acting as the app lets people delegate issues to Iskra and mention it.
const SCOPES = "read,write,app:assignable,app:mentionable";
const TOKEN_SECRET = "linear-app-token";
const TOKEN_REFRESH_EARLY_MS = 60 * 60 * 1_000;
const ISSUES_PER_REQUEST = 50;

/**
 * An OAuth app registered in Linear. The server signs in as the app with the client credentials
 * grant, so no redirect or public URL is needed.
 */
const LinearEnvConfig = Config.all({
  clientId: Config.string("ISKRA_LINEAR_CLIENT_ID").pipe(Config.option),
  clientSecret: Config.string("ISKRA_LINEAR_CLIENT_SECRET").pipe(Config.option),
});

export class LinearApiError extends Schema.TaggedError<LinearApiError>()("LinearApiError", {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Linear ${this.operation} failed: ${this.detail}`;
  }
}

export interface LinearComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly authorId: string | null;
  readonly authorName: string;
}

export interface LinearIssue {
  readonly id: string;
  readonly identifier: string;
  readonly url: string;
  readonly teamId: string;
  readonly title: string;
  readonly description: string;
  readonly updatedAt: string;
  readonly stateId: string;
  readonly stateType: string;
  readonly priority: CardPriority;
  readonly delegateId: string | null;
  readonly comments: ReadonlyArray<LinearComment>;
}

export interface LinearWorkflowState {
  readonly id: string;
  // triage, backlog, unstarted, started, completed or canceled.
  readonly type: string;
  readonly position: number;
}

export interface LinearIssueChanges {
  readonly title?: string;
  readonly description?: string;
  readonly stateId?: string;
  readonly priority?: CardPriority;
}

export class LinearClient extends Context.Service<
  LinearClient,
  {
    /** False until the app's client id and secret are set; sync does nothing until then. */
    readonly configured: Effect.Effect<boolean>;
    /** The app's own user, so the app's comments are not synced back as someone else's. */
    readonly viewerId: Effect.Effect<string, LinearApiError>;
    readonly teamStates: (
      teamId: string,
    ) => Effect.Effect<ReadonlyArray<LinearWorkflowState>, LinearApiError>;
    /** Open issues delegated to the app. */
    readonly delegatedIssues: Effect.Effect<ReadonlyArray<LinearIssue>, LinearApiError>;
    /** Open issues of a team carrying a label, delegated or not. */
    readonly labeledIssues: (
      teamId: string,
      label: string,
    ) => Effect.Effect<ReadonlyArray<LinearIssue>, LinearApiError>;
    readonly issuesByIds: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LinearIssue>, LinearApiError>;
    readonly createIssue: (
      input: { readonly teamId: string; readonly title: string; readonly description: string } & Pick<
        LinearIssueChanges,
        "stateId" | "priority"
      >,
    ) => Effect.Effect<LinearIssue, LinearApiError>;
    readonly updateIssue: (
      issueId: string,
      changes: LinearIssueChanges,
    ) => Effect.Effect<void, LinearApiError>;
    readonly createComment: (issueId: string, body: string) => Effect.Effect<void, LinearApiError>;
  }
>()("@iskra/cli/linear/LinearClient") {}

const TokenResponse = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number });
const StoredToken = Schema.Struct({
  clientId: Schema.String,
  accessToken: Schema.String,
  expiresAt: Schema.Number,
});
const decodeStoredToken = Schema.decodeUnknownOption(Schema.fromJsonString(StoredToken));
const encodeStoredToken = Schema.encodeSync(Schema.fromJsonString(StoredToken));

const IssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  priority: Schema.Number,
  team: Schema.Struct({ id: Schema.String }),
  state: Schema.Struct({ id: Schema.String, type: Schema.String }),
  delegate: Schema.NullOr(Schema.Struct({ id: Schema.String })),
  comments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        body: Schema.String,
        createdAt: Schema.String,
        user: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
      }),
    ),
  }),
});

const ISSUE_FIELDS = `id identifier url title description updatedAt priority
  team { id } state { id type } delegate { id }
  comments(first: 100) { nodes { id body createdAt user { id name } } }`;

/** Linear reports priority as a number; anything off its 0–4 scale reads as no priority. */
const toPriority = (value: number): CardPriority => {
  const rounded = Math.round(value);
  return rounded === 1 || rounded === 2 || rounded === 3 || rounded === 4 ? rounded : 0;
};

const toIssue = (node: typeof IssueNode.Type): LinearIssue => ({
  id: node.id,
  identifier: node.identifier,
  url: node.url,
  teamId: node.team.id,
  title: node.title,
  description: node.description ?? "",
  updatedAt: node.updatedAt,
  stateId: node.state.id,
  stateType: node.state.type,
  priority: toPriority(node.priority),
  delegateId: node.delegate?.id ?? null,
  comments: node.comments.nodes
    .map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      authorId: comment.user?.id ?? null,
      authorName: comment.user?.name ?? "Linear",
    }))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
});

export const make = Effect.gen(function* () {
  const config = yield* LinearEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const envCredentials =
    Option.isSome(config.clientId) && Option.isSome(config.clientSecret)
      ? { clientId: config.clientId.value, clientSecret: config.clientSecret.value }
      : null;
  // Settings win over the environment, and are read at each sign-in so new credentials apply at once.
  const credentials = serverSettings.getSettings.pipe(
    Effect.map((settings) =>
      settings.linearClientId.length > 0 && settings.linearClientSecret.length > 0
        ? { clientId: settings.linearClientId, clientSecret: settings.linearClientSecret }
        : envCredentials,
    ),
    Effect.orElseSucceed(() => envCredentials),
  );

  const failed = (operation: string) => (cause: unknown) =>
    new LinearApiError({
      operation,
      detail: cause instanceof Error ? cause.message : String(cause),
    });

  let token: typeof StoredToken.Type | null = null;
  let viewer: string | null = null;
  const accessToken = Effect.gen(function* () {
    const current = yield* credentials;
    if (current === null) {
      return yield* new LinearApiError({ operation: "sign-in", detail: "Linear is not set up." });
    }
    const now = yield* Clock.currentTimeMillis;
    if (token === null) {
      const stored = yield* secrets.get(TOKEN_SECRET).pipe(Effect.orElseSucceed(Option.none));
      token = Option.isSome(stored)
        ? Option.getOrNull(decodeStoredToken(new TextDecoder().decode(stored.value)))
        : null;
    }
    // A token belongs to the app that signed in; different credentials sign in again.
    if (token !== null && token.clientId !== current.clientId) {
      token = null;
      viewer = null;
    }
    if (token !== null && token.expiresAt - now > TOKEN_REFRESH_EARLY_MS) return token.accessToken;
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "client_credentials",
            client_id: current.clientId,
            client_secret: current.clientSecret,
            scope: SCOPES,
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
        Effect.mapError(failed("sign-in")),
      );
    const next = {
      clientId: current.clientId,
      accessToken: response.access_token,
      expiresAt: now + response.expires_in * 1_000,
    };
    token = next;
    yield* secrets
      .set(TOKEN_SECRET, new TextEncoder().encode(encodeStoredToken(next)))
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not keep the Linear token; signing in again next start.", {
            cause,
          }),
        ),
      );
    return next.accessToken;
  });

  const graphql = <S extends Schema.Top & { readonly DecodingServices: never }>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    data: S,
  ) =>
    Effect.gen(function* () {
      const bearer = yield* accessToken;
      const response = yield* httpClient
        .execute(
          HttpClientRequest.post(API_URL).pipe(
            HttpClientRequest.bearerToken(bearer),
            HttpClientRequest.bodyJsonUnsafe({ query, variables }),
          ),
        )
        .pipe(
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(
              Schema.Struct({
                data: Schema.optional(Schema.NullOr(data)),
                errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
              }),
            ),
          ),
          Effect.mapError(failed(operation)),
        );
      if (response.data === undefined || response.data === null) {
        return yield* new LinearApiError({
          operation,
          detail: response.errors?.map((error) => error.message).join("; ") ?? "No data returned.",
        });
      }
      return response.data as S["Type"];
    });

  const viewerId = Effect.suspend(() =>
    viewer !== null
      ? Effect.succeed(viewer)
      : graphql(
          "viewer",
          "query { viewer { id } }",
          {},
          Schema.Struct({ viewer: Schema.Struct({ id: Schema.String }) }),
        ).pipe(
          Effect.map(({ viewer: result }) => {
            viewer = result.id;
            return result.id;
          }),
        ),
  );

  const IssueList = Schema.Struct({ issues: Schema.Struct({ nodes: Schema.Array(IssueNode) }) });

  return {
    configured: Effect.map(credentials, (current) => current !== null),
    viewerId,
    teamStates: (teamId) =>
      graphql(
        "team states",
        "query ($id: String!) { team(id: $id) { states { nodes { id type position } } } }",
        { id: teamId },
        Schema.Struct({
          team: Schema.Struct({
            states: Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({ id: Schema.String, type: Schema.String, position: Schema.Number }),
              ),
            }),
          }),
        }),
      ).pipe(
        Effect.map(({ team }) => team.states.nodes.toSorted((a, b) => a.position - b.position)),
      ),
    delegatedIssues: graphql(
      "delegated issues",
      `query { issues(first: ${ISSUES_PER_REQUEST}, filter: { delegate: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } } }`,
      {},
      IssueList,
    ).pipe(Effect.map(({ issues }) => issues.nodes.map(toIssue))),
    labeledIssues: (teamId, label) =>
      graphql(
        "labeled issues",
        `query ($teamId: ID!, $label: String!) { issues(first: ${ISSUES_PER_REQUEST}, filter: { team: { id: { eq: $teamId } }, labels: { some: { name: { eqIgnoreCase: $label } } }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } } }`,
        { teamId, label },
        IssueList,
      ).pipe(Effect.map(({ issues }) => issues.nodes.map(toIssue))),
    issuesByIds: (ids) =>
      Effect.forEach(
        Array.from({ length: Math.ceil(ids.length / ISSUES_PER_REQUEST) }, (_, index) =>
          ids.slice(index * ISSUES_PER_REQUEST, (index + 1) * ISSUES_PER_REQUEST),
        ),
        (chunk) =>
          graphql(
            "issues",
            `query ($ids: [ID!]) { issues(first: ${ISSUES_PER_REQUEST}, filter: { id: { in: $ids } }) { nodes { ${ISSUE_FIELDS} } } }`,
            { ids: chunk },
            IssueList,
          ).pipe(Effect.map(({ issues }) => issues.nodes.map(toIssue))),
      ).pipe(Effect.map((chunks) => chunks.flat())),
    createIssue: (input) =>
      graphql(
        "create issue",
        `mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ${ISSUE_FIELDS} } } }`,
        { input },
        Schema.Struct({ issueCreate: Schema.Struct({ issue: IssueNode }) }),
      ).pipe(Effect.map(({ issueCreate }) => toIssue(issueCreate.issue))),
    updateIssue: (issueId, changes) =>
      graphql(
        "update issue",
        "mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        { id: issueId, input: changes },
        Schema.Struct({ issueUpdate: Schema.Struct({ success: Schema.Boolean }) }),
      ).pipe(Effect.asVoid),
    createComment: (issueId, body) =>
      graphql(
        "comment",
        "mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
        { input: { issueId, body } },
        Schema.Struct({ commentCreate: Schema.Struct({ success: Schema.Boolean }) }),
      ).pipe(Effect.asVoid),
  } satisfies LinearClient["Service"];
});

export const layer = Layer.effect(LinearClient, make);
