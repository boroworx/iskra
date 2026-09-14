import * as NodeOS from "node:os";

/** Throttling knobs; null or absent falls through to the next source. */
export interface ResourceProfile {
  readonly turboConcurrency?: number | null | undefined;
  readonly vitestMaxWorkers?: number | null | undefined;
  readonly nodeMaxOldSpaceMb?: number | null | undefined;
}

/**
 * The env that keeps one card's builds and tests from taking the whole machine. Derived values
 * give each job a quarter of the cores and an eighth of memory (heap capped at 4 GB); a project
 * file's hints override them, and the machine's own setting overrides both. Injected into agent
 * shells, card scripts and server-run checks.
 */
export const resourceEnvFor = (input: {
  readonly cores: number;
  readonly totalMemMB: number;
  readonly profileHints?: ResourceProfile | null | undefined;
  readonly settingsOverride?: ResourceProfile | null | undefined;
}): Record<string, string> => {
  const share = Math.max(1, Math.floor(input.cores / 4));
  const pick = (key: keyof ResourceProfile, derived: number) =>
    input.settingsOverride?.[key] ?? input.profileHints?.[key] ?? derived;
  return {
    TURBO_CONCURRENCY: String(pick("turboConcurrency", share)),
    VITEST_MAX_WORKERS: String(pick("vitestMaxWorkers", share)),
    NODE_OPTIONS: `--max-old-space-size=${pick(
      "nodeMaxOldSpaceMb",
      Math.min(4096, Math.floor(input.totalMemMB / 8)),
    )}`,
    CI: "1",
  };
};

/** `resourceEnvFor` with this machine's cores and memory. */
export const hostResourceEnv = (
  profileHints?: ResourceProfile | null,
  settingsOverride?: ResourceProfile | null,
): Record<string, string> =>
  resourceEnvFor({
    cores: NodeOS.availableParallelism(),
    totalMemMB: Math.floor(NodeOS.totalmem() / 1_048_576),
    profileHints,
    settingsOverride,
  });
