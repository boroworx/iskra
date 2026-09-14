import {
  AgentId,
  AgentName,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  RunCapabilities,
  type AgentDefinitionInput,
  type RunCapability,
} from "@iskra/contracts";
import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Where a project's agents are defined, relative to its workspace root. */
export const AGENT_DEFINITIONS_DIR = ".iskra/agents";

/** The model an agent runs when its file names none, and imported agents fall back to. */
export const DEFAULT_CLAUDE_AGENT_MODEL =
  DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")] ?? DEFAULT_MODEL;

/** Agent definitions from other tools that can be imported into a project. */
export const IMPORTABLE_AGENT_SOURCES = [{ dir: ".claude/agents" }, { dir: ".github/agents" }] as const;

/** An agent as its file defines it. `id` is null until the server assigns one. */
export type AgentDefinition = AgentDefinitionInput;

export type AgentFileResult =
  | { readonly ok: true; readonly definition: AgentDefinition }
  | { readonly ok: false; readonly error: string };

const FRONTMATTER_PATTERN = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/;

const AgentFileFrontmatter = Schema.Struct({
  id: Schema.optional(AgentId),
  name: Schema.optional(AgentName),
  avatar: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  provider: Schema.optional(ProviderInstanceId),
  model: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Unknown),
  capabilities: Schema.optional(RunCapabilities),
});

const decodeFrontmatter = Schema.decodeUnknownSync(AgentFileFrontmatter);
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);
const decodeAgentName = Schema.decodeUnknownSync(AgentName);

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function splitFrontmatter(
  contents: string,
): { readonly data: unknown; readonly body: string } | null {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (match === null) {
    return null;
  }
  return { data: parseYaml(match[1] ?? "") ?? {}, body: contents.slice(match[0].length).trim() };
}

const baseName = (fileName: string) =>
  (fileName.split(/[\\/]/).at(-1) ?? fileName).replace(/(\.agent)?\.md$/i, "");

/** A string turned into a valid agent name: lower case, dashes for anything else. */
export function toAgentNameSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 64);
}

/** Reads `.iskra/agents/<name>.md`: frontmatter, then the role prompt. */
export function parseAgentFile(contents: string, fileName: string): AgentFileResult {
  try {
    const split = splitFrontmatter(contents);
    if (split === null) {
      return { ok: false, error: "The file has no frontmatter." };
    }
    const frontmatter = decodeFrontmatter(split.data);
    const instanceId = frontmatter.provider ?? ProviderInstanceId.make("claudeAgent");
    return {
      ok: true,
      definition: {
        id: frontmatter.id ?? null,
        name: frontmatter.name ?? decodeAgentName(baseName(fileName)),
        avatar: frontmatter.avatar ?? null,
        tags: frontmatter.tags ?? [],
        modelSelection: decodeModelSelection({
          instanceId,
          model: frontmatter.model ?? DEFAULT_CLAUDE_AGENT_MODEL,
          ...(frontmatter.options !== undefined ? { options: frontmatter.options } : {}),
        }),
        capabilities: frontmatter.capabilities ?? ["read"],
        rolePrompt: split.body,
      },
    };
  } catch (cause) {
    return { ok: false, error: errorMessage(cause) };
  }
}

/** Writes an agent's file. `parseAgentFile` reads it back unchanged. */
export function serializeAgentFile(definition: AgentDefinition): string {
  const frontmatter = {
    ...(definition.id !== null ? { id: definition.id } : {}),
    name: definition.name,
    ...(definition.avatar !== null ? { avatar: definition.avatar } : {}),
    ...(definition.tags.length > 0 ? { tags: definition.tags } : {}),
    provider: definition.modelSelection.instanceId,
    model: definition.modelSelection.model,
    ...(definition.modelSelection.options !== undefined
      ? { options: definition.modelSelection.options }
      : {}),
    capabilities: definition.capabilities,
  };
  const body = definition.rolePrompt.trim();
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${body.length > 0 ? `\n${body}\n` : ""}`;
}

/** Adds `id` as the first frontmatter line, leaving the rest of the file as written. */
export function withAgentId(contents: string, id: AgentId): string {
  return contents.replace(/^---\r?\n/, (opening) => `${opening}id: ${id}\n`);
}

/** Tool names (Claude Code) and aliases (Copilot), lower-cased, to the capability they need. */
const TOOL_CAPABILITIES: Readonly<Record<string, RunCapability>> = {
  read: "read",
  glob: "read",
  grep: "read",
  ls: "read",
  search: "read",
  notebookread: "read",
  write: "write",
  edit: "write",
  multiedit: "write",
  notebookedit: "write",
  bash: "shell",
  execute: "shell",
  shell: "shell",
  powershell: "shell",
  webfetch: "network",
  websearch: "network",
  web: "network",
};

const ALL_CAPABILITIES: ReadonlyArray<RunCapability> = ["read", "write", "shell", "network"];

function toolNames(value: unknown): ReadonlyArray<string> | null {
  const list =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value.map(String) : null;
  // `Bash(git:*)` restricts a tool; the capability it needs is still the tool's.
  return list?.map((tool) => tool.trim().replace(/\(.*$/, "").toLowerCase()) ?? null;
}

/**
 * The capabilities a tool list grants. No list, or `*`, grants everything the
 * tool allowed. A disallowed tool removes its whole capability, since Iskra
 * cannot allow half of one.
 */
export function capabilitiesFromTools(
  tools: unknown,
  disallowedTools?: unknown,
): ReadonlyArray<RunCapability> {
  const allowed = toolNames(tools);
  const granted = new Set<RunCapability>(
    allowed === null || allowed.includes("*")
      ? ALL_CAPABILITIES
      : allowed.flatMap((tool) => {
          const capability = TOOL_CAPABILITIES[tool];
          return capability === undefined ? [] : [capability];
        }),
  );
  for (const tool of toolNames(disallowedTools) ?? []) {
    const capability = TOOL_CAPABILITIES[tool];
    if (capability !== undefined) {
      granted.delete(capability);
    }
  }
  return ALL_CAPABILITIES.filter((capability) => granted.has(capability));
}

/**
 * An agent from a Claude Code subagent (`.claude/agents`) or a Copilot custom
 * agent (`.github/agents`) file. The body is the role prompt; `resolveModel`
 * turns the file's `model` (an alias, a slug, `inherit` or nothing) into a
 * selection this server can run.
 */
export function importAgentFile(
  contents: string,
  fileName: string,
  resolveModel: (model: string | null) => ModelSelection,
): AgentFileResult {
  try {
    const split = splitFrontmatter(contents);
    if (split === null) {
      return { ok: false, error: "The file has no frontmatter." };
    }
    const data = (typeof split.data === "object" && split.data !== null ? split.data : {}) as {
      readonly name?: unknown;
      readonly model?: unknown;
      readonly tools?: unknown;
      readonly disallowedTools?: unknown;
    };
    const name = toAgentNameSlug(
      typeof data.name === "string" && data.name.trim().length > 0 ? data.name : baseName(fileName),
    );
    return {
      ok: true,
      definition: {
        id: null,
        name: decodeAgentName(name),
        avatar: null,
        tags: [],
        modelSelection: resolveModel(typeof data.model === "string" ? data.model.trim() : null),
        capabilities: capabilitiesFromTools(data.tools, data.disallowedTools),
        rolePrompt: split.body,
      },
    };
  } catch (cause) {
    return { ok: false, error: errorMessage(cause) };
  }
}
