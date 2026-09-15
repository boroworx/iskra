import {
  AgentId,
  DEFAULT_AGENT_BLUEPRINT,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentRole,
  type OrchestrationAgent,
  type ProviderRunRestrictions,
  type RunCapability,
} from "@iskra/contracts";
import { describe, expect, it } from "@effect/vitest";

import { selectVerifier, type VerifierProvider } from "./verifierSelection.ts";

const agent = (
  name: string,
  instance: string,
  model: string,
  overrides: {
    readonly roles?: ReadonlyArray<AgentRole>;
    readonly capabilities?: ReadonlyArray<RunCapability>;
    readonly verifyWith?: string | null;
  } = {},
): OrchestrationAgent => ({
  id: AgentId.make(`agent-${name}`),
  projectId: ProjectId.make("project-1"),
  name,
  avatar: null,
  roleTags: [],
  rolePrompt: "",
  modelSelection: { instanceId: ProviderInstanceId.make(instance), model },
  capabilities: overrides.capabilities ?? ["read", "write", "shell"],
  roles: overrides.roles ?? ["builder", "lead", "helper", "critic"],
  verifyWith: overrides.verifyWith ?? null,
  blueprint: DEFAULT_AGENT_BLUEPRINT,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
});

const provider = (
  instance: string,
  models: ReadonlyArray<string>,
  status: VerifierProvider["status"] = "ready",
): VerifierProvider => ({
  instanceId: ProviderInstanceId.make(instance),
  driver: ProviderDriverKind.make(instance),
  enabled: true,
  status,
  models: models.map((slug) => ({ slug, name: slug }) as VerifierProvider["models"][number]),
});

// The enforcement table once OpenCode can host read and read/write runs without a shell.
const fixtureRefusal = (driver: string, run: ProviderRunRestrictions): string | null => {
  const allowed: Record<string, ReadonlyArray<RunCapability>> = {
    claudeAgent: ["read", "write", "shell", "network"],
    opencode: ["read", "write"],
    codex: ["read", "write", "shell"],
  };
  const denied = run.capabilities.find((capability) => !(allowed[driver] ?? []).includes(capability));
  return denied === undefined
    ? null
    : `Agent runs on '${driver}' can't enforce ${denied}; choose a provider that can.`;
};

const builder = agent("builder", "claudeAgent", "claude-a");
const openCodeVerifier = agent("verifier-oc", "opencode", "gpt-5", {
  roles: ["verifier"],
  capabilities: ["read"],
});
const claudeProviders = provider("claudeAgent", ["claude-a", "claude-b"]);

describe("selectVerifier", () => {
  it("chooses a ready OpenCode verifier on a different provider", () => {
    const choice = selectVerifier({
      builder,
      agents: [builder, openCodeVerifier],
      providers: [claudeProviders, provider("opencode", ["gpt-5"])],
      refusal: fixtureRefusal,
    });
    expect(choice).toMatchObject({
      agent: { name: "verifier-oc" },
      modelSelection: { instanceId: "opencode", model: "gpt-5" },
      capabilities: ["read"],
      reason: { code: "differentProvider" },
    });
  });

  it("falls back to another Claude model when OpenCode isn't ready", () => {
    const choice = selectVerifier({
      builder,
      agents: [builder, openCodeVerifier],
      providers: [claudeProviders, provider("opencode", ["gpt-5"], "error")],
      refusal: fixtureRefusal,
    });
    expect(choice).toMatchObject({
      agent: { name: "builder" },
      modelSelection: { instanceId: "claudeAgent", model: "claude-b" },
      reason: { code: "sameProviderVerifier" },
    });
  });

  it("skips an OpenCode verifier whose template adds a shell OpenCode can't enforce", () => {
    const choice = selectVerifier({
      builder,
      agents: [builder, { ...openCodeVerifier, capabilities: ["read", "shell"] }],
      providers: [claudeProviders, provider("opencode", ["gpt-5"])],
      refusal: fixtureRefusal,
    });
    expect(choice).toMatchObject({ reason: { code: "sameProviderVerifier" } });
  });

  it("falls back to the builder's own model when no other model is offered", () => {
    const choice = selectVerifier({
      builder,
      agents: [builder],
      providers: [provider("claudeAgent", ["claude-a"])],
      refusal: fixtureRefusal,
    });
    expect(choice).toMatchObject({
      agent: { name: "builder" },
      modelSelection: { model: "claude-a" },
      reason: { code: "sameModelVerifier" },
    });
  });

  it("never chooses Codex, even where the table would allow it", () => {
    const codexVerifier = agent("verifier-codex", "codex", "gpt-5-codex", {
      roles: ["verifier"],
      capabilities: ["read"],
    });
    const choice = selectVerifier({
      builder: { ...builder, verifyWith: "verifier-codex" },
      agents: [builder, codexVerifier],
      providers: [claudeProviders, provider("codex", ["gpt-5-codex"])],
      refusal: fixtureRefusal,
    });
    expect(choice).toMatchObject({ reason: { code: "sameProviderVerifier" } });
  });

  it("prefers the template's verifyWith and skips a name that matches no agent", () => {
    const claudeVerifier = agent("verifier-claude", "claudeAgent", "claude-b", {
      roles: ["verifier"],
      capabilities: ["read"],
    });
    const providers = [claudeProviders, provider("opencode", ["gpt-5"])];
    const agents = [builder, openCodeVerifier, claudeVerifier];

    expect(
      selectVerifier({
        builder: { ...builder, verifyWith: "verifier-claude" },
        agents,
        providers,
        refusal: fixtureRefusal,
      }),
    ).toMatchObject({ agent: { name: "verifier-claude" }, reason: { code: "sameProviderVerifier" } });
    expect(
      selectVerifier({ builder: { ...builder, verifyWith: "nobody" }, agents, providers, refusal: fixtureRefusal }),
    ).toMatchObject({ agent: { name: "verifier-oc" }, reason: { code: "differentProvider" } });
  });

  it("works against the real enforcement table whether or not it lists OpenCode yet", () => {
    const choice = selectVerifier({
      builder,
      agents: [builder, openCodeVerifier],
      providers: [claudeProviders, provider("opencode", ["gpt-5"])],
    });
    expect(["differentProvider", "sameProviderVerifier"]).toContain(
      "reason" in choice ? choice.reason.code : choice.refusal,
    );
  });

  it("refuses when the builder's own provider can't host the verifier run", () => {
    const codexBuilder = agent("builder", "codex", "gpt-5-codex");
    const choice = selectVerifier({
      builder: codexBuilder,
      agents: [codexBuilder],
      providers: [provider("codex", ["gpt-5-codex"])],
      refusal: fixtureRefusal,
    });
    expect(choice).toEqual({
      refusal: "Agent runs on 'codex' can't enforce its restrictions; choose a provider that can.",
    });
  });
});
