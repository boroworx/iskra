import type { ProjectId, ProjectScript, ServerSettings } from "@iskra/contracts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

/**
 * The project's override wins, then environment defaults. Until the legacy
 * fields have been folded into `projectSettingsOverrides`, the old map (null
 * there meant "reset to machine defaults") and the aggregate's own scripts
 * still count, so a server that has not run the fold yet behaves as before.
 */
export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

export function projectScriptsInheritDefaults(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  if (settings.projectSettingsOverrides[project.id]?.defaultProjectScripts !== undefined) {
    return false;
  }
  if (settings.projectSettingsFolded) return true;
  const legacy = settings.projectScriptOverrides[project.id];
  return legacy === null || (legacy === undefined && project.scripts.length === 0);
}

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    ISKRA_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.ISKRA_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

/** "c" plus the last 6 of the card id's [a-z0-9] characters: safe in database names and key prefixes. */
export function cardSlug(cardId: string): string {
  return `c${cardId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "")
    .slice(-6)}`;
}

/** The env var a named card port is handed in: `publicApi` → `ISKRA_PORT_PUBLIC_API`. */
export function cardPortEnvName(name: string): string {
  return `ISKRA_PORT_${name.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

/**
 * What every script that runs for a card receives (setup, run, archive, checks, services): its
 * id and slug, its port block (ISKRA_PORT is the older name for ISKRA_PORT_BASE) and each named
 * port at its offset in the block.
 */
export function cardScriptEnv(input: {
  cardId: string;
  portBase: number;
  portCount: number;
  ports: Readonly<Record<string, number>>;
}): Record<string, string> {
  const env: Record<string, string> = {
    ISKRA_CARD_ID: input.cardId,
    ISKRA_CARD_SLUG: cardSlug(input.cardId),
    ISKRA_PORT_BASE: String(input.portBase),
    ISKRA_PORT: String(input.portBase),
    ISKRA_PORT_COUNT: String(input.portCount),
  };
  for (const [name, offset] of Object.entries(input.ports)) {
    env[cardPortEnvName(name)] = String(input.portBase + offset);
  }
  return env;
}

/** The script that prepares a new worktree: role `setup`, or the legacy `runOnWorktreeCreate` flag. */
export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return (
    scripts.find((script) => script.role === "setup") ??
    scripts.find((script) => script.role === undefined && script.runOnWorktreeCreate) ??
    null
  );
}

/** The scripts that verify a card's worktree: tests, lint, a verify command. All must pass. */
export function checkProjectScripts(scripts: readonly ProjectScript[]): readonly ProjectScript[] {
  return scripts.filter((script) => script.role === "check");
}

/** The script that cleans up a card's worktree before it is removed. */
export function archiveProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.role === "archive") ?? null;
}
