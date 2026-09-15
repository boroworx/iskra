import { describe, expect, it } from "vite-plus/test";

import {
  canHostRuns,
  providerRunSummary,
  runRefusalText,
  templateRunRefusal,
} from "./runEnforcementView.ts";

describe("runRefusalText", () => {
  // The server's refusal texts (M2 plan B2 and B4); a template shows the one the server would send.
  it("matches the server's refusals per provider", () => {
    expect(runRefusalText("opencode", { capabilities: ["read", "write", "shell"] })).toBe(
      "Agent runs on 'opencode' can't enforce shell; choose a provider that can.",
    );
    expect(runRefusalText("opencode", { capabilities: ["read", "network"] })).toBe(
      "Agent runs on 'opencode' can't enforce network; choose a provider that can.",
    );
    expect(runRefusalText("codex", { capabilities: ["read"] })).toBe(
      "Agent runs on 'codex' can't enforce its restrictions; choose a provider that can.",
    );
    expect(runRefusalText("codex", { capabilities: [] })).toBe(
      "Agent runs on 'codex' can't enforce its restrictions; choose a provider that can.",
    );
    expect(runRefusalText("cursor", { capabilities: [] })).toBe(
      "Agent runs on 'cursor' can't enforce its restrictions; choose a provider that can.",
    );
    expect(
      runRefusalText("opencode", { capabilities: ["read", "write", "shell"], egressAllowlist: true }),
    ).toBe("Agent runs on 'opencode' can't enforce shell; choose a provider that can.");
    expect(runRefusalText("opencode", { capabilities: ["read"] }, { external: true })).toBe(
      "Agent runs on 'opencode' can't use an external OpenCode server; choose a provider that can.",
    );
  });

  it("ignores an egress allowlist for runs that can't reach the network, as the server does", () => {
    expect(
      runRefusalText("opencode", { capabilities: ["read", "write"], egressAllowlist: true }),
    ).toBeNull();
  });

  it("lets each provider run what it can enforce", () => {
    expect(
      runRefusalText("claudeAgent", {
        capabilities: ["read", "write", "shell", "network"],
        egressAllowlist: true,
      }),
    ).toBeNull();
    expect(runRefusalText("opencode", { capabilities: ["read", "write"] })).toBeNull();
    expect(canHostRuns("opencode")).toBe(true);
    expect(canHostRuns("codex")).toBe(false);
    expect(providerRunSummary("opencode")).toBe(
      "OpenCode runs can read and edit files but can't use a shell.",
    );
    expect(providerRunSummary("codex")).toBeNull();
  });

  it("gives a template on a provider that hosts no runs its fail-closed refusal", () => {
    expect(templateRunRefusal("codex", ["read", "write"])).toBe(
      "Agent runs on 'codex' can't enforce its restrictions; choose a provider that can.",
    );
    expect(templateRunRefusal("opencode", ["read", "write", "shell"])).toBe(
      "Agent runs on 'opencode' can't enforce shell; choose a provider that can.",
    );
    expect(templateRunRefusal("opencode", ["read"])).toBeNull();
  });
});
