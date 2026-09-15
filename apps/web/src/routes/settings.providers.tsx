import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@iskra/contracts";

import { CardRuntimeSettings } from "../components/settings/ProjectOrchestrationSettings";
import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { AgentThreadDefaultsSettings } from "../components/settings/SettingsPanels";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { usePrimaryEnvironmentId } from "../state/environments";

/**
 * Agents & Providers. Providers are machine state, so the provider list shows
 * one environment at a time: the chosen one, or the representative of the
 * selection. A project crumb narrows the candidates to the environments that
 * project is registered on. Agent thread defaults and the card runtime follow.
 */
function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const { environment, scope } = useSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const agentSettings = (
    <>
      <AgentThreadDefaultsSettings />
      <CardRuntimeSettings environmentId={primaryEnvironmentId} />
    </>
  );
  if (!environment) {
    return (
      <SettingsPageContainer width="wide">
        <p className="text-[13px] text-muted-foreground">
          {scope.kind === "environment"
            ? `Reconnect ${scope.label} to set up its providers.`
            : "Connect an environment to set up its providers."}
        </p>
        {agentSettings}
      </SettingsPageContainer>
    );
  }
  return (
    <ProviderSettingsPanel
      environmentId={environment.environmentId}
      {...(target.instanceId ? { instanceId: target.instanceId } : {})}
      scoped
    >
      {agentSettings}
    </ProviderSettingsPanel>
  );
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});
