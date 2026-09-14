import { describe, expect, it } from "vite-plus/test";

import { cardScriptEnv, cardSlug } from "./projectScripts.ts";

describe("cardScriptEnv", () => {
  it("hands a card its id, slug, port block and named ports", () => {
    expect(
      cardScriptEnv({
        cardId: "card-7F3a_91xQ",
        portBase: 42_010,
        portCount: 10,
        ports: { web: 0, server: 2, publicApi: 4 },
      }),
    ).toEqual({
      ISKRA_CARD_ID: "card-7F3a_91xQ",
      ISKRA_CARD_SLUG: "c3a91xq",
      ISKRA_PORT_BASE: "42010",
      ISKRA_PORT: "42010",
      ISKRA_PORT_COUNT: "10",
      ISKRA_PORT_WEB: "42010",
      ISKRA_PORT_SERVER: "42012",
      ISKRA_PORT_PUBLIC_API: "42014",
    });
  });

  it("keeps the slug to lowercase letters and digits", () => {
    expect(cardSlug("0b94c79c-1d2e-4f5a-9b8c-ABCDEF123456")).toBe("c123456");
    expect(cardSlug("x")).toMatch(/^c[a-z0-9]{1,6}$/);
  });
});
