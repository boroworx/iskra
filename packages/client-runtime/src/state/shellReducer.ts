import * as Arr from "effect/Array";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

/**
 * Reduce a single shell stream event into an existing snapshot, returning a new
 * snapshot with the event's changes applied. This is a pure reducer that both
 * web and mobile can use to keep their local shell snapshot in sync.
 *
 * Returns the original snapshot reference unchanged if the event is not
 * recognized (forward-compatible).
 */
export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project-upserted": {
      const projects = snapshot.projects.some((p) => p.id === event.project.id)
        ? Arr.map(snapshot.projects, (p) => (p.id === event.project.id ? event.project : p))
        : Arr.append(snapshot.projects, event.project);
      return { ...snapshot, projects, snapshotSequence: event.sequence };
    }
    case "project-removed":
      return {
        ...snapshot,
        projects: Arr.filter(snapshot.projects, (p) => p.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread-upserted": {
      const threads = snapshot.threads.some((t) => t.id === event.thread.id)
        ? Arr.map(snapshot.threads, (t) => (t.id === event.thread.id ? event.thread : t))
        : Arr.append(snapshot.threads, event.thread);
      return { ...snapshot, threads, snapshotSequence: event.sequence };
    }
    case "thread-removed":
      return {
        ...snapshot,
        threads: Arr.filter(snapshot.threads, (t) => t.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    case "agent-upserted": {
      const current = snapshot.agents ?? [];
      const agents = current.some((a) => a.id === event.agent.id)
        ? Arr.map(current, (a) => (a.id === event.agent.id ? event.agent : a))
        : Arr.append(current, event.agent);
      return { ...snapshot, agents, snapshotSequence: event.sequence };
    }
    case "agent-removed":
      return {
        ...snapshot,
        agents: Arr.filter(snapshot.agents ?? [], (a) => a.id !== event.agentId),
        snapshotSequence: event.sequence,
      };
    case "channel-upserted": {
      const current = snapshot.channels ?? [];
      const channels = current.some((c) => c.id === event.channel.id)
        ? Arr.map(current, (c) => (c.id === event.channel.id ? event.channel : c))
        : Arr.append(current, event.channel);
      return { ...snapshot, channels, snapshotSequence: event.sequence };
    }
    case "channel-removed":
      return {
        ...snapshot,
        channels: Arr.filter(snapshot.channels ?? [], (c) => c.id !== event.channelId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}
