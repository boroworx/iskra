/**
 * The bundled first-run project: a tiny Node app whose one test fails until a card fixes it. Kept
 * as strings so the server bundle carries it and no test runner here picks up its failing test.
 * Agent files leave out default roles and blueprints, as Iskra itself writes them.
 */
export const SAMPLE_PROJECT_FILES: ReadonlyArray<{ readonly path: string; readonly contents: string }> = [
  {
    path: "package.json",
    contents: `{
  "name": "iskra-sample",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
  },
  {
    path: "README.md",
    contents: `# Iskra sample

A tiny Node app for trying Iskra. \`slugify\` has a bug, so \`npm test\` fails until a card fixes it.
`,
  },
  {
    path: "src/slugify.js",
    contents: `/** Turns a title into a URL slug: "Hello World" becomes "hello-world". */
export function slugify(title) {
  return title.trim().replace(/\\s+/g, "-");
}
`,
  },
  {
    path: "test/slugify.test.js",
    contents: `import assert from "node:assert/strict";
import { test } from "node:test";

import { slugify } from "../src/slugify.js";

test("slugify lowercases a title and joins its words with dashes", () => {
  assert.equal(slugify("  Hello World "), "hello-world");
});
`,
  },
  {
    path: ".iskra/project.json",
    contents: `{
  "checks": [{ "id": "test", "name": "Tests", "command": "node --test", "timeoutMinutes": 2 }]
}
`,
  },
  {
    path: ".iskra/agents/lead.md",
    contents: `---
name: lead
capabilities:
  - read
roles:
  - lead
---

You lead this project's channel. Turn requests into small cards with clear acceptance criteria.
`,
  },
  {
    path: ".iskra/agents/builder.md",
    contents: `---
name: builder
capabilities:
  - read
  - write
  - shell
---

You build this project's cards. Keep changes small and leave the tests passing.
`,
  },
  {
    path: ".iskra/agents/verifier.md",
    contents: `---
name: verifier
capabilities:
  - read
  - shell
roles:
  - verifier
---

You verify cards against their acceptance criteria. Judge the work, not its intentions.
`,
  },
];

/** The triage card the sample project starts with. */
export const SAMPLE_PROJECT_CARD = {
  title: "Fix slugify so the tests pass",
  spec: "`slugify` in src/slugify.js keeps capital letters, so the test in test/slugify.test.js fails. Make it lowercase the title.",
  criteria: [
    { id: "c1", text: 'slugify("  Hello World ") returns "hello-world".', verification: "automated" },
    { id: "c2", text: "The project's tests pass.", verification: "automated" },
  ],
} as const;
