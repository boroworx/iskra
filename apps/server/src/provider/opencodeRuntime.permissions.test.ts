import * as NodeAssert from "node:assert/strict";

import * as RegExpUtils from "effect/RegExp";
import { describe, it } from "vite-plus/test";

import type { RunCapability } from "@iskra/contracts";

import {
  buildOpenCodePermissionRules,
  buildOpenCodeRunPermissionRules,
  openCodeRunConfigContent,
  toOpenCodePermissionReply,
} from "./opencodeRuntime.ts";

function actionFor(
  runtimeMode: Parameters<typeof buildOpenCodePermissionRules>[0],
  permission: string,
  target = "*",
) {
  // OpenCode uses the last matching rule. Its wildcards match directory separators.
  return buildOpenCodePermissionRules(runtimeMode).findLast(
    (rule) =>
      (rule.permission === "*" || rule.permission === permission) &&
      new RegExp(`^${RegExpUtils.escape(rule.pattern).replaceAll("\\*", ".*")}$`, "s").test(target),
  )?.action;
}

describe("buildOpenCodePermissionRules", () => {
  it("pre-approves edits once the user has chosen to auto-accept them", () => {
    NodeAssert.equal(actionFor("auto-accept-edits", "edit"), "allow");
  });

  it("still asks before editing when approval is required", () => {
    NodeAssert.equal(actionFor("approval-required", "edit"), "ask");
  });

  // Documented in docs/user/permission-modes.md: providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for "auto".
  it("leaves auto asking, as the docs say it does without a reviewer", () => {
    NodeAssert.equal(actionFor("auto", "edit"), "ask");
  });

  it("allows workspace reads and task updates without asking in supervised modes", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      for (const permission of ["read", "glob", "grep", "lsp", "skill", "todowrite"]) {
        NodeAssert.equal(actionFor(runtimeMode, permission, "src/index.ts"), "allow");
      }
    }
  });

  it("preserves OpenCode's environment-file approval rules", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      for (const target of [
        ".env",
        ".env.local",
        "config/service.env",
        "config/service.env.local",
      ]) {
        NodeAssert.equal(actionFor(runtimeMode, "read", target), "ask");
      }
      for (const target of [".env.example", "config/service.env.example"]) {
        NodeAssert.equal(actionFor(runtimeMode, "read", target), "allow");
      }
    }
  });

  it("still asks before commands, network access, external directories and unknown tools", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      NodeAssert.equal(actionFor(runtimeMode, "bash"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "webfetch"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "websearch"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "external_directory"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "doom_loop"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "custom_tool"), "ask");
    }
  });

  it("allows everything only under full access", () => {
    NodeAssert.deepEqual(buildOpenCodePermissionRules("full-access"), [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ]);
  });
});

describe("buildOpenCodeRunPermissionRules", () => {
  const wildcard = (glob: string) =>
    new RegExp(`^${RegExpUtils.escape(glob).replaceAll("\\*", ".*")}$`, "s");
  const actionForRun = (capabilities: ReadonlyArray<RunCapability>, permission: string) =>
    buildOpenCodeRunPermissionRules({ systemPrompt: "", capabilities }).findLast(
      (rule) => wildcard(rule.permission).test(permission) && wildcard(rule.pattern).test("*"),
    )?.action;

  it("lets a read run use file tools and Iskra's tools, and nothing else", () => {
    for (const permission of ["read", "glob", "grep", "list", "iskra_record_verdict"]) {
      NodeAssert.equal(actionForRun(["read"], permission), "allow");
    }
    for (const permission of [
      "edit",
      "bash",
      "webfetch",
      "websearch",
      "codesearch",
      "task",
      "external_directory",
      "doom_loop",
      "question",
      "skill",
      "decoy_tool",
    ]) {
      NodeAssert.equal(actionForRun(["read"], permission), "deny", permission);
    }
  });

  it("allows edits only with write, and never a shell", () => {
    NodeAssert.equal(actionForRun(["read", "write"], "edit"), "allow");
    NodeAssert.equal(actionForRun(["read", "write", "shell"], "bash"), "deny");
  });
});

describe("openCodeRunConfigContent", () => {
  it("keeps only the inherited model providers and carries the run's rules", () => {
    const inherited = JSON.stringify({
      provider: { probe: { npm: "@ai-sdk/openai-compatible" } },
      mcp: { decoy: { type: "remote", url: "http://127.0.0.1:1" } },
      permission: { "*": "allow" },
    });
    const config = JSON.parse(
      openCodeRunConfigContent({ systemPrompt: "", capabilities: ["read"] }, inherited),
    );
    NodeAssert.deepEqual(config.provider, { probe: { npm: "@ai-sdk/openai-compatible" } });
    NodeAssert.deepEqual(config.mcp, {});
    NodeAssert.equal(config.permission["*"], "deny");
    NodeAssert.equal(config.permission.edit, "deny");
    NodeAssert.equal(config.formatter, false);
    NodeAssert.equal(config.lsp, false);
  });
});

describe("toOpenCodePermissionReply", () => {
  it.each([
    ["accept", "once"],
    ["acceptForSession", "always"],
    ["acceptAlways", "always"],
    ["decline", "reject"],
    ["cancel", "reject"],
  ] as const)("maps %s to %s", (decision, reply) => {
    NodeAssert.equal(toOpenCodePermissionReply(decision), reply);
  });
});
