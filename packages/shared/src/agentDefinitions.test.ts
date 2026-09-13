import { AgentId, ProviderInstanceId, type ModelSelection } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  capabilitiesFromTools,
  importAgentFile,
  parseAgentFile,
  serializeAgentFile,
  withAgentId,
  type AgentDefinition,
} from "./agentDefinitions.ts";

const claude = ProviderInstanceId.make("claudeAgent");

const definition = (result: ReturnType<typeof parseAgentFile>): AgentDefinition => {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.definition;
};

describe("parseAgentFile", () => {
  it("reads the frontmatter and takes the body as the role prompt", () => {
    const parsed = definition(
      parseAgentFile(
        [
          "---",
          "id: agent-backend",
          "name: backend",
          "tags: [server, api]",
          "provider: claudeAgent",
          "model: claude-sonnet-5",
          "capabilities: [read, write]",
          "---",
          "",
          "Owns the server.",
          "",
        ].join("\n"),
        "backend.md",
      ),
    );

    expect(parsed).toEqual({
      id: AgentId.make("agent-backend"),
      name: "backend",
      avatar: null,
      tags: ["server", "api"],
      modelSelection: { instanceId: claude, model: "claude-sonnet-5" },
      capabilities: ["read", "write"],
      rolePrompt: "Owns the server.",
    });
  });

  it("names the agent after its file and defaults to a read-only Claude agent", () => {
    const parsed = definition(parseAgentFile("---\n---\nReviews changes.\n", "reviewer.md"));

    expect(parsed.id).toBeNull();
    expect(parsed.name).toBe("reviewer");
    expect(parsed.modelSelection.instanceId).toBe(claude);
    expect(parsed.capabilities).toEqual(["read"]);
  });

  it("rejects a file without frontmatter, a bad name or an unknown capability", () => {
    expect(parseAgentFile("Just text", "notes.md").ok).toBe(false);
    expect(parseAgentFile("---\nname: Back End\n---\n", "x.md").ok).toBe(false);
    expect(parseAgentFile("---\ncapabilities: [deploy]\n---\n", "ops.md").ok).toBe(false);
  });

  it("reads back what serializeAgentFile writes", () => {
    const written: AgentDefinition = {
      id: AgentId.make("agent-frontend"),
      name: "frontend" as AgentDefinition["name"],
      avatar: "🎨",
      tags: ["ui"],
      modelSelection: { instanceId: claude, model: "claude-opus-5" },
      capabilities: ["read", "write", "shell"],
      rolePrompt: "Owns the web app.\n\nKeeps it fast.",
    };

    expect(definition(parseAgentFile(serializeAgentFile(written), "frontend.md"))).toEqual(written);
  });
});

describe("withAgentId", () => {
  it("adds the id without touching the rest of the file", () => {
    const contents = "---\n# the API owner\nname: backend\n---\nOwns the server.\n";

    const updated = withAgentId(contents, AgentId.make("agent-1"));

    expect(updated).toBe(
      "---\nid: agent-1\n# the API owner\nname: backend\n---\nOwns the server.\n",
    );
    expect(definition(parseAgentFile(updated, "backend.md")).id).toBe("agent-1");
  });
});

describe("capabilitiesFromTools", () => {
  it("maps Claude Code tools and Copilot aliases to capabilities", () => {
    expect(capabilitiesFromTools("Read, Grep, Glob")).toEqual(["read"]);
    expect(capabilitiesFromTools(["Read", "Edit", "Bash(git:*)"])).toEqual([
      "read",
      "write",
      "shell",
    ]);
    expect(capabilitiesFromTools(["read", "search", "execute", "web"])).toEqual([
      "read",
      "shell",
      "network",
    ]);
  });

  it("grants everything without a list, and removes a disallowed tool's capability", () => {
    expect(capabilitiesFromTools(undefined)).toEqual(["read", "write", "shell", "network"]);
    expect(capabilitiesFromTools(["*"])).toEqual(["read", "write", "shell", "network"]);
    expect(capabilitiesFromTools(undefined, "Write, WebFetch")).toEqual(["read", "shell"]);
  });
});

describe("importAgentFile", () => {
  const resolveModel = (model: string | null): ModelSelection => ({
    instanceId: claude,
    model: model === "sonnet" ? "claude-sonnet-5" : "claude-fable-5-1",
  });

  it("keeps a Claude Code subagent's prompt, model and tools", () => {
    const imported = definition(
      importAgentFile(
        [
          "---",
          "name: code-reviewer",
          "description: Reviews code for quality",
          "tools: Read, Glob, Grep",
          "model: sonnet",
          "---",
          "",
          "You are a code reviewer.",
        ].join("\n"),
        ".claude/agents/code-reviewer.md",
        resolveModel,
      ),
    );

    expect(imported).toEqual({
      id: null,
      name: "code-reviewer",
      avatar: null,
      tags: [],
      modelSelection: { instanceId: claude, model: "claude-sonnet-5" },
      capabilities: ["read"],
      rolePrompt: "You are a code reviewer.",
    });
  });

  it("names a Copilot agent after its file when it has no name", () => {
    const imported = definition(
      importAgentFile(
        "---\ndescription: Improves tests\ntools: [read, edit]\n---\nYou write tests.\n",
        ".github/agents/Test_Specialist.agent.md",
        resolveModel,
      ),
    );

    expect(imported.name).toBe("test-specialist");
    expect(imported.capabilities).toEqual(["read", "write"]);
    expect(imported.modelSelection.model).toBe("claude-fable-5-1");
  });
});
