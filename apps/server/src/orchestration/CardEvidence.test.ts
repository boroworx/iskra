import { describe, expect, it } from "vite-plus/test";

import {
  changedFilesOf,
  evidenceUrl,
  judgeScope,
  renderReviewRequest,
  riskClaimsOf,
  uiEvidenceRequired,
  type ChangedFile,
} from "./CardEvidence.ts";

describe("review request risk claims", () => {
  it("reads back the claims a review request was recorded with, notes included", () => {
    const risks = {
      sideEffect: "high",
      performance: "low",
      compatibility: "medium",
      notes: "Sends email on signup.\nOnly in staging.",
    } as const;
    const body = renderReviewRequest("Adds signup emails.", risks);
    expect(body).toBe(
      "Adds signup emails.\n\nRisks (claimed): side effects high, performance low, compatibility medium.\nSends email on signup.\nOnly in staging.",
    );
    expect(riskClaimsOf(body)).toEqual(risks);
    expect(riskClaimsOf(renderReviewRequest("x", { ...risks, notes: " " }))).toEqual({
      ...risks,
      notes: "",
    });
    expect(riskClaimsOf("Just a message.")).toBeNull();
  });
});

const file = (
  path: string,
  status: ChangedFile["status"] = "modified",
  addedLines: ReadonlyArray<string> = [],
): ChangedFile => ({ path, status, addedLines });

const kinds = (input: Parameters<typeof judgeScope>[0]) =>
  judgeScope({ ...input }).map((flag) => [flag.kind, flag.path, flag.hard]);

describe("scope judge", () => {
  it.each([
    ["a deleted test file", [file("src/limits.test.ts", "deleted")], [["deletedTest", "src/limits.test.ts", true]]],
    ["a deleted Go test", [file("pkg/limit_test.go", "deleted")], [["deletedTest", "pkg/limit_test.go", true]]],
    ["a deleted source file", [file("src/limits.ts", "deleted")], []],
    ["a new it.skip", [file("src/a.test.ts", "modified", ['  it.skip("works", () => {'])], [["skippedTest", "src/a.test.ts", true]]],
    ["a focused test", [file("src/a.spec.tsx", "modified", ["describe.only('x', () => {"])], [["skippedTest", "src/a.spec.tsx", true]]],
    ["an xit", [file("spec/a.js", "added", ["xit('x')"])], [["skippedTest", "spec/a.js", true]]],
    ["a JUnit @Disabled", [file("src/FooTest.java", "modified", ["  @Disabled"])], [["skippedTest", "src/FooTest.java", true]]],
    ["a Rust #[ignore]", [file("src/lib.rs", "modified", ["#[ignore]"])], [["skippedTest", "src/lib.rs", true]]],
    ["a word that only looks like skip", [file("src/a.ts", "modified", ["const skipped = items.skip(2);"])], []],
    ["Iskra's project file", [file(".iskra/project.json")], [["protectedPath", ".iskra/project.json", true]]],
    ["a CI workflow", [file(".github/workflows/ci.yml", "added")], [["protectedPath", ".github/workflows/ci.yml", true]]],
    ["another .github file", [file(".github/CODEOWNERS")], []],
  ] as const)("flags %s", (_name, files, expected) => {
    expect(kinds({ files, manifests: [], likelyAreas: [] })).toEqual(expected);
  });

  it("flags dependency downgrades only, across dependency sections", () => {
    const before = JSON.stringify({
      dependencies: { effect: "^3.4.0", react: "19.1.0" },
      devDependencies: { vitest: "~4.1.2" },
    });
    const after = JSON.stringify({
      dependencies: { effect: "^3.10.0", react: "18.3.1", zod: "^4.0.0" },
      devDependencies: { vitest: "~4.1.1" },
    });
    expect(
      judgeScope({
        files: [file("package.json")],
        manifests: [{ path: "package.json", before, after }],
        likelyAreas: [],
      }).map((flag) => flag.detail),
    ).toEqual(["react 19.1.0 → 18.3.1", "vitest ~4.1.2 → ~4.1.1"]);
  });

  it("advises on files outside the likely areas without blocking, capped", () => {
    const files = [
      file("apps/server/limits.ts"),
      ...Array.from({ length: 12 }, (_, index) => file(`apps/web/page${index}.tsx`)),
    ];
    const flags = judgeScope({ files, manifests: [], likelyAreas: ["apps/server/**"] });
    expect(flags).toHaveLength(10);
    expect(flags.every((flag) => flag.kind === "outsideLikelyAreas" && !flag.hard)).toBe(true);
    expect(flags.at(-1)?.detail).toBe("Outside the estimate's likely areas, with 2 more.");
    expect(judgeScope({ files, manifests: [], likelyAreas: [] })).toEqual([]);
  });
});

describe("changed files", () => {
  it("pairs git's name-status with the lines each file adds", () => {
    const files = changedFilesOf(
      "M\tsrc/a.ts\nA\tsrc/b.test.ts\nD\tsrc/old.test.ts\nR100\tsrc/from.ts\tsrc/to.ts\n",
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/src/old.test.ts b/src/old.test.ts",
        "--- a/src/old.test.ts",
        "+++ /dev/null",
        "-gone",
        "+++ b/src/b.test.ts",
        "+it.only('x')",
      ].join("\n"),
    );
    expect(files).toEqual([
      { path: "src/a.ts", status: "modified", addedLines: ["new"] },
      { path: "src/b.test.ts", status: "added", addedLines: ["it.only('x')"] },
      { path: "src/old.test.ts", status: "deleted", addedLines: [] },
      { path: "src/to.ts", status: "modified", addedLines: [] },
    ]);
    expect(uiEvidenceRequired(files)).toBe(false);
    expect(uiEvidenceRequired([file("apps/web/Page.tsx")])).toBe(true);
    expect(uiEvidenceRequired([file("apps/web/Page.tsx", "deleted")])).toBe(false);
  });
});

describe("evidence URL", () => {
  it("reaches only loopback on the card's own ports", () => {
    expect(evidenceUrl({ port: 42003, portBase: 42000, path: "/limits?tab=1" })).toBe(
      "http://127.0.0.1:42003/limits?tab=1",
    );
    expect(evidenceUrl({ port: 42000, portBase: 42000, path: "settings" })).toBe(
      "http://127.0.0.1:42000/settings",
    );
    expect(evidenceUrl({ port: 42010, portBase: 42000, path: "/" })).toBeNull();
    expect(evidenceUrl({ port: 5432, portBase: 42000, path: "/" })).toBeNull();
    expect(evidenceUrl({ port: 42001, portBase: 42000, path: "//evil.example/" })).toBeNull();
    expect(evidenceUrl({ port: 42001, portBase: 42000, path: "/@evil.example" })).toBe(
      "http://127.0.0.1:42001/@evil.example",
    );
  });
});
