import type { RunCapability } from "@iskra/contracts";

/**
 * A client copy of the server's run enforcement table (`apps/server/src/provider/runEnforcement.ts`),
 * so agent settings can say which provider can run a template before anything is saved or started.
 * The server stays the authority and refuses on its own; keep the table and the texts in step.
 */
const RUN_ENFORCEMENT: Readonly<
  Record<string, { capabilities: ReadonlyArray<RunCapability>; egressAllowlist: boolean }>
> = {
  claudeAgent: { capabilities: ["read", "write", "shell", "network"], egressAllowlist: true },
  opencode: { capabilities: ["read", "write"], egressAllowlist: false },
  codex: { capabilities: [], egressAllowlist: false },
};

/**
 * Why runs on `provider` can't have these capabilities, in the server's words; null when it can
 * enforce them all. Providers not in the table host no runs.
 */
export function runRefusalText(
  provider: string,
  run: { readonly capabilities: ReadonlyArray<RunCapability>; readonly egressAllowlist?: boolean },
): string | null {
  const enforcement = RUN_ENFORCEMENT[provider] ?? { capabilities: [], egressAllowlist: false };
  const missing =
    run.egressAllowlist === true && !enforcement.egressAllowlist
      ? "an egress allowlist"
      : (run.capabilities.find((capability) => !enforcement.capabilities.includes(capability)) ??
        (enforcement.capabilities.length === 0 ? "its restrictions" : undefined));
  return missing === undefined
    ? null
    : `Agent runs on '${provider}' can't enforce ${missing}; choose a provider that can.`;
}

/** Whether `provider` can host any run at all; a model picker offers only these. */
export const canHostRuns = (provider: string): boolean =>
  (RUN_ENFORCEMENT[provider]?.capabilities.length ?? 0) > 0;

/**
 * Why an agent template's card runs can't start on `provider`, or null. A provider that hosts no
 * runs shows its fail-closed refusal whatever the template's capabilities.
 */
export const templateRunRefusal = (
  provider: string,
  capabilities: ReadonlyArray<RunCapability>,
): string | null => runRefusalText(provider, { capabilities: canHostRuns(provider) ? capabilities : [] });

const RUN_SUMMARY: Readonly<Record<string, string>> = {
  claudeAgent: "Claude runs can read, edit, use a shell and reach allowed domains.",
  opencode: "OpenCode runs can read and edit files but can't use a shell.",
};

/** What runs on `provider` can do, in one line; null when it hosts no runs (its refusal says why). */
export const providerRunSummary = (provider: string): string | null =>
  RUN_SUMMARY[provider] ?? null;
