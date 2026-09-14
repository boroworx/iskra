import { describe, expect, it } from "vite-plus/test";

import { resourceEnvFor } from "./ResourceEnv.ts";

describe("resourceEnvFor", () => {
  it.each([
    { cores: 2, totalMemMB: 8_192, turbo: "1", heap: "--max-old-space-size=1024" },
    { cores: 10, totalMemMB: 16_384, turbo: "2", heap: "--max-old-space-size=2048" },
    { cores: 16, totalMemMB: 65_536, turbo: "4", heap: "--max-old-space-size=4096" },
  ])("gives a job a quarter of $cores cores and an eighth of $totalMemMB MB", (row) => {
    expect(resourceEnvFor({ cores: row.cores, totalMemMB: row.totalMemMB })).toEqual({
      TURBO_CONCURRENCY: row.turbo,
      VITEST_MAX_WORKERS: row.turbo,
      NODE_OPTIONS: row.heap,
      CI: "1",
    });
  });

  it("lets project hints override derived values and the machine setting override both", () => {
    const env = resourceEnvFor({
      cores: 16,
      totalMemMB: 65_536,
      profileHints: { turboConcurrency: 2, vitestMaxWorkers: 3, nodeMaxOldSpaceMb: null },
      settingsOverride: { turboConcurrency: 1, vitestMaxWorkers: null, nodeMaxOldSpaceMb: 3_000 },
    });
    expect(env).toMatchObject({
      TURBO_CONCURRENCY: "1",
      VITEST_MAX_WORKERS: "3",
      NODE_OPTIONS: "--max-old-space-size=3000",
    });
  });
});
