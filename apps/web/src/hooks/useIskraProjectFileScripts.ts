import {
  ISKRA_PROJECT_FILE_NAME,
  type EnvironmentId,
  type IskraProjectFile,
  type IskraProjectFileScript,
} from "@iskra/contracts";
import { parseIskraProjectFile } from "@iskra/shared/iskraProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<IskraProjectFileScript> = [];

export interface IskraProjectFileState {
  /**
   * - `valid`: iskra.json exists and decoded.
   * - `invalid`: iskra.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable iskra.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: IskraProjectFile | null;
  scripts: ReadonlyArray<IskraProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `iskra.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useIskraProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): IskraProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    ISKRA_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseIskraProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `iskra.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useIskraProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<IskraProjectFileScript> {
  return useIskraProjectFileState(environmentId, cwd).scripts;
}
