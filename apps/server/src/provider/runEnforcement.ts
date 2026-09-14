/**
 * Pure rules for what an Iskra run may do, shared by ProviderService (which providers may
 * host a run) and the adapters that enforce it (heavy commands, the agent's environment).
 */
import type { ProviderRunRestrictions, RunCapability } from "@iskra/contracts";

/** Full-suite commands a run leaves to run_checks. A project's `heavyCommands` replace these. */
export const DEFAULT_HEAVY_COMMANDS: ReadonlyArray<string> = [
  "pnpm test",
  "pnpm build",
  "turbo run test",
  "turbo run build",
  "npm test",
  "vitest run",
];

export const HEAVY_COMMAND_REFUSAL =
  "This runs the full suite; call run_checks instead. A single test file is fine.";

const SEPARATORS = new Set([";", "|", "&", "\n", "(", ")", "`"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const PACKAGE_RUNNERS = ["pnpm", "npm", "yarn", "bun"];
// Words that may precede the heavy command without changing what it runs.
const PREFIX_WORDS = new Set(
  PACKAGE_RUNNERS.concat(["env", "time", "nice", "nohup", "command", "exec"]).concat([
    "npx",
    "bunx",
    "pnpx",
    "dlx",
  ]),
);
const RUN_ALIASED = new Set([...PACKAGE_RUNNERS, "turbo"]);

/** Splits a command line into simple commands of unquoted words. */
function simpleCommands(command: string): Array<Array<string>> {
  const commands: Array<Array<string>> = [];
  let words: Array<string> = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"' && index + 1 < command.length) {
        index += 1;
        word += command[index];
      } else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "\\" && index + 1 < command.length) {
      index += 1;
      if (command[index] !== "\n") word += command[index];
      started = true;
    } else if (character === "$" && command[index + 1] === "(") {
      index += 1;
      endCommand();
    } else if (
      character === "&" &&
      (command[index - 1] === ">" || command[index + 1] === ">" || command[index - 1] === "<")
    ) {
      // `2>&1` and `&>` are redirections, not background operators.
      word += character;
      started = true;
    } else if (SEPARATORS.has(character)) {
      endCommand();
    } else if (/\s/.test(character)) {
      endWord();
    } else {
      word += character;
      started = true;
    }
  }
  endCommand();
  return commands;
}

/** Drops redirections such as `> out/log.txt` or `2>/dev/null`, whose targets look like paths. */
function withoutRedirections(words: ReadonlyArray<string>): Array<string> {
  const kept: Array<string> = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (!/^\d*(?:>>?|<|&>)/.test(word)) kept.push(word);
    else if (/^\d*(?:>>?|<|&>)(?:&\d*)?$/.test(word) && !word.includes("&")) index += 1;
  }
  return kept;
}

// `pnpm run test` and `turbo test` run the same thing as `pnpm test` and `turbo run test`.
function normalized(words: ReadonlyArray<string>): Array<string> {
  return words.filter(
    (word, index) => !(word === "run" && index > 0 && RUN_ALIASED.has(words[index - 1]!)),
  );
}

const isPrefixWord = (word: string) =>
  PREFIX_WORDS.has(word) ||
  word.startsWith("-") ||
  /^\d+$/.test(word) ||
  /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

const isTargeting = (word: string) =>
  word === "--filter" ||
  word === "-F" ||
  word.startsWith("--filter=") ||
  (!word.startsWith("-") && (word.includes("/") || /\.[cm]?[jt]sx?$/.test(word)));

function matchesHeavy(words: ReadonlyArray<string>, pattern: ReadonlyArray<string>): boolean {
  for (let start = 0; start < words.length; start += 1) {
    if (words[start] !== pattern[0]) {
      if (isPrefixWord(words[start]!)) continue;
      return false;
    }
    let next = 1;
    let index = start + 1;
    for (; index < words.length && next < pattern.length; index += 1) {
      if (words[index] === pattern[next]) next += 1;
      else if (!words[index]!.startsWith("-")) break;
    }
    if (next < pattern.length) {
      if (isPrefixWord(words[start]!)) continue;
      return false;
    }
    return !words.some(isTargeting);
  }
  return false;
}

/**
 * Whether a shell command runs one of the heavy commands untargeted, anywhere in a `&&`, `;` or
 * `|` chain or inside `sh -c`/`bash -c`/`eval`. A file path or `--filter` makes it targeted.
 * ponytail: word matching, not a shell parser; aliases, scripts and variables slip through, so
 * the throttled resource env stays the backstop.
 */
export function isHeavyCommand(
  command: string,
  heavyCommands: ReadonlyArray<string>,
  depth = 0,
): boolean {
  if (depth > 3) return false;
  const patterns = heavyCommands
    .map((heavy) => normalized(heavy.trim().split(/\s+/)))
    .filter((pattern) => pattern.length > 0 && pattern[0] !== "");
  return simpleCommands(command).some((raw) => {
    const words = normalized(withoutRedirections(raw));
    const programIndex = words.findIndex((word) => !isPrefixWord(word));
    const program = programIndex === -1 ? undefined : words[programIndex];
    if (program !== undefined && SHELLS.has(program)) {
      const flag = words.findIndex(
        (word, index) => index > programIndex && /^-\w*c\w*$/.test(word),
      );
      const script = flag === -1 ? undefined : words[flag + 1];
      if (script !== undefined && isHeavyCommand(script, heavyCommands, depth + 1)) return true;
    }
    if (
      program === "eval" &&
      isHeavyCommand(words.slice(programIndex + 1).join(" "), heavyCommands, depth + 1)
    ) {
      return true;
    }
    return patterns.some((pattern) => matchesHeavy(words, pattern));
  });
}

// What every run's environment keeps; everything else, including forge and cloud tokens, is dropped.
const RUN_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);
const RUN_ENV_PREFIXES = ["LC_", "XDG_", "ISKRA_"];
const SECRET_LIKE = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(?:^|_)KEY(?:$|_)/;

/** The Claude CLI's own configuration and credentials, which its process needs. */
export function claudeRunEnvNames(env: Readonly<Record<string, string | undefined>>) {
  return {
    names: [
      "CLAUDE_CONFIG_DIR",
      ...(env.CLAUDE_CODE_USE_VERTEX
        ? ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "CLOUD_ML_REGION"]
        : []),
    ],
    prefixes: ["ANTHROPIC_", "CLAUDE_CODE_", ...(env.CLAUDE_CODE_USE_BEDROCK ? ["AWS_"] : [])],
  };
}

/**
 * A run's environment: an allowlist of shell basics, non-secret ISKRA_* variables and the
 * provider's own variables, with git never prompting for credentials.
 */
export function runEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  provider: { readonly names: ReadonlyArray<string>; readonly prefixes: ReadonlyArray<string> },
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const own = provider.names.includes(name) || provider.prefixes.some((p) => name.startsWith(p));
    const basic =
      RUN_ENV_NAMES.has(name) ||
      (RUN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) && !SECRET_LIKE.test(name));
    if (own || basic) result[name] = value;
  }
  result.GIT_TERMINAL_PROMPT = "0";
  return result;
}

/** What each provider can enforce for a run. Providers not listed can't host runs. */
const RUN_ENFORCEMENT: Readonly<
  Record<string, { capabilities: ReadonlyArray<RunCapability>; egressAllowlist: boolean }>
> = {
  claudeAgent: { capabilities: ["read", "write", "shell", "network"], egressAllowlist: true },
  // Codex's network is all-or-nothing, and its sandbox isn't verified on a real binary yet.
  codex: { capabilities: [], egressAllowlist: false },
};

/** Why `provider` can't host this run, or null when it can enforce everything the run needs. */
export function runRefusal(provider: string, run: ProviderRunRestrictions): string | null {
  const enforcement = RUN_ENFORCEMENT[provider] ?? { capabilities: [], egressAllowlist: false };
  const missing =
    run.egress?.mode === "allowlist" && !enforcement.egressAllowlist
      ? "an egress allowlist"
      : (run.capabilities.find((capability) => !enforcement.capabilities.includes(capability)) ??
        (enforcement.capabilities.length === 0 ? "its restrictions" : undefined));
  return missing === undefined
    ? null
    : `Agent runs on '${provider}' can't enforce ${missing}; choose a provider that can.`;
}
