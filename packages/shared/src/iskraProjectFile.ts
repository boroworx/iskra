import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { IskraProjectFile, ISKRA_PROJECT_FILE_SCHEMA_URL } from "@iskra/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `iskra.json` file contents (lenient JSONC string) and the
 * decoded {@link IskraProjectFile}.
 */
export const IskraProjectFileFromJson = fromLenientJson(IskraProjectFile);

const decodeIskraProjectFile = Schema.decodeExit(IskraProjectFileFromJson);

/**
 * Decode raw `iskra.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseIskraProjectFile(contents: string): IskraProjectFile | null {
  const decoded = decodeIskraProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `iskra.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link ISKRA_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildIskraProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(IskraProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: ISKRA_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
