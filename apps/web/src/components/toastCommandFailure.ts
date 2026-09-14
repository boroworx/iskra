import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@iskra/client-runtime/state/runtime";

import { toastManager } from "./ui/toast";

/** Toasts a failed command with its error's message, or the fallback; an interrupted one stays quiet. */
export function toastCommandFailure(
  result: AtomCommandResult<unknown, unknown>,
  title: string,
  fallback: string,
): void {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : fallback,
    });
  }
}
