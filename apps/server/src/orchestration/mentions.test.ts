import { AgentId } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseMentions } from "./mentions.ts";

const backend = { id: AgentId.make("agent-backend"), name: "backend" };
const frontend = { id: AgentId.make("agent-frontend"), name: "frontend" };
const reviewer = { id: AgentId.make("agent-code-review"), name: "code-review" };
const agents = [backend, frontend, reviewer];

describe("parseMentions", () => {
  it("returns mentioned agents in order of first mention, once each", () => {
    expect(parseMentions("@frontend and @backend, then @frontend again", agents)).toEqual([
      frontend.id,
      backend.id,
    ]);
  });

  it("matches names case-insensitively and keeps hyphens in names", () => {
    expect(parseMentions("@Backend can @code-review look?", agents)).toEqual([
      backend.id,
      reviewer.id,
    ]);
  });

  it("treats unknown names, bare @ signs and email addresses as plain text", () => {
    expect(parseMentions("ask @nobody, or mail dev@backend.io @ noon", agents)).toEqual([]);
    expect(parseMentions("no mentions here", agents)).toEqual([]);
  });

  it("accepts mentions at the start of a line and after punctuation", () => {
    expect(parseMentions("@backend\n(@frontend)", agents)).toEqual([backend.id, frontend.id]);
  });
});
