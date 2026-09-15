import { describe, expect, it } from "@effect/vitest";

import { errorText, OrchestrationCommandInvariantError } from "./Errors.ts";

describe("errorText", () => {
  it("keeps a refusal's own sentence, without the command it refused", () => {
    const refusal = new OrchestrationCommandInvariantError({
      commandType: "card.session.record",
      detail: "The card's model has no known price; accept running it uncapped to continue.",
    });
    expect(refusal.message).toContain("Orchestration command invariant failed");
    expect(`The verifier couldn't start: ${errorText(refusal)}`).toBe(
      "The verifier couldn't start: The card's model has no known price; accept running it uncapped to continue.",
    );
    expect(errorText(new Error("git exited 128"))).toBe("git exited 128");
    expect(errorText("lost")).toBe("lost");
  });
});
