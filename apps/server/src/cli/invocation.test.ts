import { assert, it } from "@effect/vitest";

import { formatCliCommand } from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/@iskra/cli/dist/bin.mjs", "npx @iskra/cli serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@iskra\\cli\\dist\\bin.mjs",
      "npx @iskra/cli serve",
    ],
    [
      "/home/theo/.cache/pnpm/dlx/abc/node_modules/@iskra/cli/dist/bin.mjs",
      "pnpm dlx @iskra/cli serve",
    ],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/@iskra/cli/dist/bin.mjs",
      "pnpm dlx @iskra/cli serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\@iskra\\cli\\dist\\bin.mjs",
      "pnpm dlx @iskra/cli serve",
    ],
    ["/home/theo/.bun/install/cache/@iskra/cli@0.0.31/dist/bin.mjs", "bunx @iskra/cli serve"],
    ["/tmp/bunx-1000-iskra@latest/node_modules/@iskra/cli/dist/bin.mjs", "bunx @iskra/cli serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-iskra@latest\\node_modules\\@iskra\\cli\\dist\\bin.mjs",
      "bunx @iskra/cli serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/@iskra/cli/dist/bin.mjs",
    "/home/theo/Code/work/iskra/apps/server/dist/bin.mjs",
    "/home/theo/.iskra/runtime/0.0.31/node_modules/@iskra/cli/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "iskra serve",
    );
  }
});

it("re-suggests the prerelease channel only for prerelease builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx @iskra/cli@nightly serve"],
    ["0.0.31-preview.20260729.1", "npx @iskra/cli@preview serve"],
    ["0.0.31-foo-preview.20260729.1", "npx @iskra/cli serve"],
    ["0.0.31", "npx @iskra/cli serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/@iskra/cli/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/@iskra/cli/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx @iskra/cli@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-iskra@latest/node_modules/@iskra/cli/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx @iskra/cli serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/@iskra/cli/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "iskra serve",
  );
});
