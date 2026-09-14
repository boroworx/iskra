import type { EnvironmentId, ModelSelection, ServerProvider } from "@iskra/contracts";
import { createModelSelection } from "@iskra/shared/model";
import { useMemo } from "react";

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

/**
 * The model a new agent runs on. Agent runs need Claude, so it is the project's
 * default model when that is a Claude one, otherwise the first available Claude
 * instance's default; null when no Claude instance is on.
 */
export function resolveAgentModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  projectDefault: ModelSelection | null,
): ModelSelection | null {
  const claudeEntries = deriveProviderInstanceEntries(providers).filter(
    (entry) => entry.driverKind === "claudeAgent" && entry.enabled && entry.installed,
  );
  if (
    projectDefault !== null &&
    claudeEntries.some((entry) => entry.instanceId === projectDefault.instanceId)
  ) {
    return projectDefault;
  }
  for (const entry of claudeEntries) {
    const model = getDefaultProviderInstanceModel(providers, entry.instanceId);
    if (model !== undefined) {
      return { instanceId: entry.instanceId, model };
    }
  }
  return null;
}

/**
 * The model picker for an agent: only enabled, installed Claude instances, since
 * only Claude runs agents. A new pick drops the old model's options.
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
      ).filter((entry) => entry.driverKind === "claudeAgent" && entry.enabled && entry.installed),
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
  return (
    <ProviderModelPicker
      activeInstanceId={props.value.instanceId}
      model={props.value.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptions}
      triggerVariant="outline"
      triggerAriaLabel="Agent model"
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      onInstanceModelChange={(instanceId, model) =>
        props.onChange(createModelSelection(instanceId, model))
      }
    />
  );
}
