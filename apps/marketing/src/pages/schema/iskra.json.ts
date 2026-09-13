import type { APIRoute } from "astro";

import { buildIskraProjectFileJsonSchema } from "@iskra/shared/iskraProjectFile";

// Rendered at build time; published at https://iskra.sh/schema/iskra.json so
// iskra.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildIskraProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
