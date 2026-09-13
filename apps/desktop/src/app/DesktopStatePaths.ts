import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(iskraHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(iskraHome)) {
    return Option.none();
  }
  const trimmed = iskraHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly iskraHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.iskraHome), () =>
    input.joinPath(input.homeDirectory, ".iskra"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly iskraHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.iskraHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
