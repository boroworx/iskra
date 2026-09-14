import { createCardEnvironmentAtoms } from "@iskra/client-runtime/state/cards";

import { connectionAtomRuntime } from "../connection/runtime";

export const cardEnvironment = createCardEnvironmentAtoms(connectionAtomRuntime);
