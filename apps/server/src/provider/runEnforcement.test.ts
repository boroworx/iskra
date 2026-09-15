import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_HEAVY_COMMANDS,
  claudeRunEnvNames,
  isHeavyCommand,
  opencodeRunEnvNames,
  runEnvironment,
  runRefusal,
} from "./runEnforcement.ts";

describe("isHeavyCommand", () => {
  it.each([
    ["pnpm test", true],
    ["pnpm run test", true],
    ["pnpm -w build", true],
    ["npm test", true],
    ["turbo run test", true],
    ["turbo test", true],
    ["pnpm turbo run build", true],
    ["vitest run", true],
    ["npx vitest run --reporter dot", true],
    ["CI=1 nice -n 10 pnpm test", true],
    ["cd apps/web && pnpm test", true],
    ["pnpm install; pnpm build", true],
    ["pnpm test 2>&1 | tail -50", true],
    ["pnpm test > out/log.txt", true],
    ["pnpm test 2>/dev/null", true],
    ["(cd pkg && turbo run test)", true],
    ['sh -c "pnpm lint && pnpm test"', true],
    ["bash -lc 'turbo run build'", true],
    ['eval "pnpm test"', true],
    ["echo $(pnpm test)", true],
    // Targeted: a file path or --filter.
    ["pnpm test src/foo.test.ts", false],
    ["vitest run src/foo.test.ts", false],
    ["npx vitest run apps/web/src/button.test.tsx", false],
    ["pnpm --filter @app/web test", false],
    ["turbo run test --filter=@app/web", false],
    ["turbo run build -F web", false],
    ['sh -c "pnpm test src/a.test.ts"', false],
    // Not the heavy command at all.
    ["pnpm lint", false],
    ["pnpm add vitest", false],
    ["vitest", false],
    ["echo pnpm test", false],
    ["git commit -m 'pnpm test'", false],
    ["grep -r 'turbo run build' .", false],
  ])("%s -> %s", (command, heavy) => {
    expect(isHeavyCommand(command, DEFAULT_HEAVY_COMMANDS)).toBe(heavy);
  });

  it("uses the project's heavy commands instead of the defaults", () => {
    expect(isHeavyCommand("make e2e", ["make e2e"])).toBe(true);
    expect(isHeavyCommand("pnpm test", ["make e2e"])).toBe(false);
  });
});

describe("runEnvironment", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/Users/dev",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "xterm",
    TMPDIR: "/tmp",
    ISKRA_HOME: "/Users/dev/.iskra",
    ISKRA_DEV_AUTH_TOKEN: "dev-token",
    GH_TOKEN: "gh",
    GITHUB_TOKEN: "gh",
    GITLAB_TOKEN: "gl",
    GL_TOKEN: "gl",
    NPM_TOKEN: "npm",
    AWS_ACCESS_KEY_ID: "aws",
    AWS_SECRET_ACCESS_KEY: "aws",
    OPENAI_API_KEY: "openai",
    STRIPE_SECRET_KEY: "stripe",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    ANTHROPIC_API_KEY: "anthropic",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    CLAUDE_CONFIG_DIR: "/Users/dev/.claude",
    GIT_TERMINAL_PROMPT: "1",
  };

  it("keeps shell basics, safe ISKRA_* and the provider's own variables", () => {
    expect(runEnvironment(host, claudeRunEnvNames(host))).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/dev",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm",
      TMPDIR: "/tmp",
      ISKRA_HOME: "/Users/dev/.iskra",
      ANTHROPIC_API_KEY: "anthropic",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CONFIG_DIR: "/Users/dev/.claude",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("keeps AWS credentials only when Claude authenticates through Bedrock", () => {
    const bedrock = { ...host, CLAUDE_CODE_USE_BEDROCK: "1" };
    const env = runEnvironment(bedrock, claudeRunEnvNames(bedrock));
    expect(env.AWS_ACCESS_KEY_ID).toBe("aws");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("runRefusal", () => {
  const run = (overrides: object = {}) => ({
    systemPrompt: "",
    capabilities: ["read", "write", "shell"] as const,
    ...overrides,
  });

  it("lets Claude host any run, allowlisted egress included", () => {
    expect(
      runRefusal("claudeAgent", run({ egress: { mode: "allowlist", allow: ["x.dev"], deny: [] } })),
    ).toBeNull();
  });

  it("refuses Codex runs until its sandbox is verified on a real binary", () => {
    for (const restrictions of [
      run({ capabilities: ["read"] }),
      run({ egress: { mode: "allowlist", allow: ["x.dev"], deny: [] } }),
    ]) {
      expect(runRefusal("codex", restrictions)).toBe(
        "Agent runs on 'codex' can't enforce its restrictions; choose a provider that can.",
      );
    }
  });

  it.each(["cursor", "grok", "antigravity"])("refuses %s runs", (provider) => {
    expect(runRefusal(provider, run({ capabilities: ["read"] }))).toBe(
      `Agent runs on '${provider}' can't enforce its restrictions; choose a provider that can.`,
    );
  });

  it("lets OpenCode host read and write runs, never a shell or network", () => {
    const allowlist = { mode: "allowlist" as const, allow: ["x.dev"], deny: [] };
    expect(runRefusal("opencode", run({ capabilities: ["read"], egress: allowlist }))).toBeNull();
    expect(runRefusal("opencode", run({ capabilities: ["read", "write"] }))).toBeNull();
    expect(runRefusal("opencode", run())).toBe(
      "Agent runs on 'opencode' can't enforce shell; choose a provider that can.",
    );
    expect(runRefusal("opencode", run({ capabilities: ["read", "network"] }))).toBe(
      "Agent runs on 'opencode' can't enforce network; choose a provider that can.",
    );
  });

  it("refuses a run on an external OpenCode server", () => {
    expect(runRefusal("opencode", run({ capabilities: ["read"] }), { external: true })).toBe(
      "Agent runs on 'opencode' can't use an external OpenCode server; choose a provider that can.",
    );
  });
});

describe("opencodeRunEnvNames", () => {
  it("keeps OpenCode's credentials and only the model provider's API key", () => {
    const host = {
      PATH: "/usr/bin",
      OPENCODE_SERVER_PASSWORD: "pw",
      OPENCODE_CONFIG: "/Users/dev/.config/opencode/work.json",
      OPENCODE_CONFIG_DIR: "/Users/dev/.config/opencode-work",
      OPENAI_API_KEY: "openai",
      ANTHROPIC_API_KEY: "anthropic",
      GH_TOKEN: "gh",
    };
    expect(runEnvironment(host, opencodeRunEnvNames("openai/gpt-5"))).toEqual({
      PATH: "/usr/bin",
      OPENCODE_SERVER_PASSWORD: "pw",
      OPENAI_API_KEY: "openai",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});
