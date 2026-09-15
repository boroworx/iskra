import {
  canHostRuns,
  providerRunSummary,
  runRefusalText,
  templateRunRefusal,
} from "@iskra/client-runtime/run-enforcement";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  RunCapability,
  ServerProvider,
} from "@iskra/contracts";
import { createModelSelection } from "@iskra/shared/model";
import { useCallback, useMemo } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { useServerConfigs } from "~/state/entities";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** An environment's provider list, for resolving agent models. */
export function useEnvironmentProviders(environmentId: EnvironmentId) {
  return useServerConfigs().get(environmentId)?.providers ?? EMPTY_PROVIDERS;
}

/** The driver a model selection runs on, such as `claudeAgent`; null when its instance is gone. */
export const selectionDriver = (
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId">,
): string | null =>
  providers.find((provider) => provider.instanceId === selection.instanceId)?.driver ?? null;

/**
 * The model a new agent runs on: the project's default model when its provider can host runs,
 * otherwise the first available Claude instance's default (Claude enforces every capability a
 * new agent starts with), then any other provider that hosts runs; null when none is on.
 */
export function resolveAgentModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  projectDefault: ModelSelection | null,
): ModelSelection | null {
  const entries = deriveProviderInstanceEntries(providers).filter(
    (entry) => entry.enabled && entry.installed && canHostRuns(entry.driverKind),
  );
  if (
    projectDefault !== null &&
    entries.some((entry) => entry.instanceId === projectDefault.instanceId)
  ) {
    return projectDefault;
  }
  const claudeFirst = [
    ...entries.filter((entry) => entry.driverKind === "claudeAgent"),
    ...entries.filter((entry) => entry.driverKind !== "claudeAgent"),
  ];
  for (const entry of claudeFirst) {
    const model = getDefaultProviderInstanceModel(providers, entry.instanceId);
    if (model !== undefined) {
      return { instanceId: entry.instanceId, model };
    }
  }
  return null;
}

/**
 * The model picker for an agent: every enabled, installed provider. Models on a provider that
 * can't host agent runs, such as Codex, stay listed but disabled with the server's refusal.
 * A new pick drops the old model's options.
 */
export function AgentModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly value: ModelSelection;
  readonly onChange: (selection: ModelSelection) => void;
  readonly disabled?: boolean;
}) {
  const providers = useEnvironmentProviders(props.environmentId);
  const settings = useEnvironmentSettings(props.environmentId);
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ).filter((entry) => entry.enabled && entry.installed),
    [providers, settings],
  );
  const modelOptions = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        props.value.instanceId,
        props.value.model,
      ),
    [settings, providers, props.value.instanceId, props.value.model],
  );
  const disabledReason = useCallback(
    (instanceId: ProviderInstanceId) => {
      const driver = entries.find((entry) => entry.instanceId === instanceId)?.driverKind;
      return driver === undefined || canHostRuns(driver)
        ? null
        : runRefusalText(driver, { capabilities: [] });
    },
    [entries],
  );
  return (
    <ProviderModelPicker
      activeInstanceId={props.value.instanceId}
      model={props.value.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptions}
      triggerVariant="outline"
      triggerAriaLabel="Agent model"
      getModelDisabledReason={disabledReason}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      onInstanceModelChange={(instanceId, model) =>
        props.onChange(createModelSelection(instanceId, model))
      }
    />
  );
}

/** Why this template's card runs can't start on its model's provider, or null when they can. */
export function useAgentRunRefusal(
  environmentId: EnvironmentId,
  model: Pick<ModelSelection, "instanceId"> | null,
  capabilities: ReadonlyArray<RunCapability>,
): { readonly driver: string | null; readonly refusal: string | null } {
  const providers = useEnvironmentProviders(environmentId);
  const driver = model === null ? null : selectionDriver(providers, model);
  return { driver, refusal: driver === null ? null : templateRunRefusal(driver, capabilities) };
}

/** Under an agent's capabilities: what its provider's runs can do, or the refusal that blocks saving. */
export function AgentRunNote(props: {
  readonly driver: string | null;
  readonly refusal: string | null;
}) {
  if (props.refusal !== null) {
    return (
      <p role="alert" className="text-xs text-destructive-foreground">
        {props.refusal}
      </p>
    );
  }
  const summary = props.driver === null ? null : providerRunSummary(props.driver);
  return summary === null ? null : <p className="text-xs text-muted-foreground">{summary}</p>;
}
