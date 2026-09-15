import type {
  ModelSelection,
  OrchestrationAgent,
  ProviderRunRestrictions,
  Reason,
  RunCapability,
  ServerProvider,
} from "@iskra/contracts";

import { runRefusal } from "../provider/runEnforcement.ts";

/** What selection reads of a provider instance's snapshot. */
export type VerifierProvider = Pick<ServerProvider, "instanceId" | "driver" | "enabled" | "status" | "models">;

export interface VerifierChoice {
  readonly agent: OrchestrationAgent;
  readonly modelSelection: ModelSelection;
  readonly capabilities: ReadonlyArray<RunCapability>;
  readonly reason: Reason;
}

/**
 * A verifier reads. A dedicated verifier template may add a shell, which its provider must then
 * enforce; a builder's template verifying as a fallback keeps its shell for building.
 */
export const verifierCapabilities = (
  agent: Pick<OrchestrationAgent, "capabilities" | "roles">,
): ReadonlyArray<RunCapability> =>
  agent.roles.includes("verifier") && agent.capabilities.includes("shell")
    ? ["read", "shell"]
    : ["read"];

/**
 * Who checks a card built by `builder`, in order: the template's `verifyWith`, a verifier on a
 * different provider that is ready and can enforce the run (OpenCode first), the builder's template
 * on another model of its provider, then the builder's own model. Codex is never chosen, and a
 * `verifyWith` naming no usable agent is skipped. Pure: the caller loads agents and providers.
 */
export function selectVerifier(input: {
  readonly builder: OrchestrationAgent;
  /** The project's agents. */
  readonly agents: ReadonlyArray<OrchestrationAgent>;
  readonly providers: ReadonlyArray<VerifierProvider>;
  /** The enforcement table; tests pass their own. */
  readonly refusal?: (provider: string, run: ProviderRunRestrictions) => string | null;
}): VerifierChoice | { readonly refusal: string } {
  const { builder, agents, providers } = input;
  const refusalOf = input.refusal ?? runRefusal;
  const providerOf = (selection: ModelSelection) =>
    providers.find((provider) => provider.instanceId === selection.instanceId);
  const driverOf = (selection: ModelSelection): string =>
    providerOf(selection)?.driver ?? selection.instanceId;
  const ready = (selection: ModelSelection) => {
    const provider = providerOf(selection);
    return provider !== undefined && provider.enabled && provider.status === "ready";
  };
  const refusalFor = (agent: OrchestrationAgent) =>
    driverOf(agent.modelSelection) === "codex"
      ? "Agent runs on 'codex' can't enforce its restrictions; choose a provider that can."
      : refusalOf(driverOf(agent.modelSelection), {
          systemPrompt: "",
          capabilities: verifierCapabilities(agent),
        });
  const usable = (agent: OrchestrationAgent) =>
    agent.archivedAt === null && ready(agent.modelSelection) && refusalFor(agent) === null;
  const builderDriver = driverOf(builder.modelSelection);

  const choose = (
    agent: OrchestrationAgent,
    modelSelection: ModelSelection,
    code: "differentProvider" | "sameProviderVerifier" | "sameModelVerifier",
  ): VerifierChoice => ({
    agent,
    modelSelection,
    capabilities: verifierCapabilities(agent),
    reason: {
      code,
      text:
        code === "differentProvider"
          ? `@${agent.name} verifies on ${driverOf(modelSelection)}, a different provider from the builder's.`
          : code === "sameProviderVerifier"
            ? `No verifier on another provider is ready, so @${agent.name} verifies on ${modelSelection.model}, a different model from the builder's.`
            : `No other provider or model can verify, so @${agent.name} verifies on the builder's own model.`,
    },
  });

  const preferred = agents.find(
    (agent) =>
      builder.verifyWith !== null &&
      agent.name === builder.verifyWith &&
      (agent.id === builder.id || agent.roles.includes("verifier")) &&
      usable(agent),
  );
  if (preferred !== undefined) {
    return choose(
      preferred,
      preferred.modelSelection,
      driverOf(preferred.modelSelection) !== builderDriver
        ? "differentProvider"
        : preferred.modelSelection.model !== builder.modelSelection.model
          ? "sameProviderVerifier"
          : "sameModelVerifier",
    );
  }

  const otherProvider = agents
    .filter(
      (agent) =>
        agent.id !== builder.id &&
        agent.roles.includes("verifier") &&
        driverOf(agent.modelSelection) !== builderDriver &&
        usable(agent),
    )
    .toSorted(
      (a, b) =>
        Number(driverOf(b.modelSelection) === "opencode") -
        Number(driverOf(a.modelSelection) === "opencode"),
    )[0];
  if (otherProvider !== undefined) {
    return choose(otherProvider, otherProvider.modelSelection, "differentProvider");
  }

  const builderRefusal = refusalFor(builder);
  if (builderRefusal !== null) {
    return { refusal: builderRefusal };
  }
  const otherModel = providerOf(builder.modelSelection)?.models.find(
    (model) => model.slug !== builder.modelSelection.model,
  );
  return otherModel === undefined
    ? choose(builder, builder.modelSelection, "sameModelVerifier")
    : choose(
        builder,
        { instanceId: builder.modelSelection.instanceId, model: otherModel.slug },
        "sameProviderVerifier",
      );
}
