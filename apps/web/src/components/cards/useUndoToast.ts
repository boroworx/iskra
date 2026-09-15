import { UNDOABLE_LABEL, undoCommandOf, type UndoableCommand } from "@iskra/client-runtime/undo";
import type { EnvironmentId } from "@iskra/contracts";
import { useCallback } from "react";

import { cardEnvironment } from "~/state/cards";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastCommandFailure } from "../toastCommandFailure";
import { toastManager } from "../ui/toast";

/** After a reversible command succeeds, a toast whose Undo sends its reverse. */
export function useUndoToast() {
  const undo = useAtomCommand(cardEnvironment.undo);
  return useCallback(
    (environmentId: EnvironmentId, command: UndoableCommand) => {
      const reverse = undoCommandOf(command);
      if (reverse === null) return;
      const toastId = toastManager.add({
        type: "success",
        title: UNDOABLE_LABEL[command.type],
        actionProps: {
          children: "Undo",
          onClick: () => {
            toastManager.close(toastId);
            void undo({ environmentId, input: reverse }).then((result) =>
              toastCommandFailure(result, "It was not undone", "The request was refused."),
            );
          },
        },
      });
    },
    [undo],
  );
}
