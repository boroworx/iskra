import { RefreshIcon } from "~/components/ui/refresh-icon";
import { AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type {
  BackgroundBooleanState,
  EnvironmentId,
  ResourceAttributionEntry,
  ResourceTelemetryAggregate,
  ResourceTelemetryHistoryBucket,
  ResourceTelemetryIoSemantics,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessCategory,
  ResourceTelemetryProcessSummary,
  ResourceTelemetrySourceHealth,
  ResourceTelemetrySourceStatus,
  ServerProcessSignal,
} from "@iskra/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@iskra/client-runtime/state/runtime";

import {
  useResourceTelemetry,
  useResourceTelemetryHistory,
} from "../../lib/resourceTelemetryState";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTime } from "../../timestampFormat";
import { StatusPill } from "../iskra/StatusPill";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  resourceHistoryBarHeight,
  resourceHistoryCpuScaleMax,
  shouldShowResourceMonitorRetry,
  visibleResourceTelemetryProcesses,
} from "./ResourceTelemetryDiagnostics.logic";
import { SettingsSection, useRelativeTimeTick } from "./settingsLayout";

const HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 15_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 30_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 2 * 60_000 },
] as const;

function formatBytes(value: number): string {
  if (value < 1_024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let next = value;
  let unitIndex = -1;
  do {
    next /= 1_024;
    unitIndex += 1;
  } while (next >= 1_024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 100 ? 0 : next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function formatCpuTime(valueMs: number): string {
  const seconds = valueMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`;
  return `${(minutes / 60).toFixed(2)}h`;
}

function formatDurationMicros(value: number): string {
  if (value < 1_000) return `${Math.round(value)} µs`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(2)} ms`;
  return `${(value / 1_000_000).toFixed(2)} s`;
}

function formatSampleInterval(valueMs: number): string {
  if (valueMs < 1_000) return `${Math.max(0, Math.round(valueMs))} ms`;
  const seconds = valueMs / 1_000;
  return `${seconds.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${
    seconds === 1 ? "second" : "seconds"
  }`;
}

function processIdentityKey(process: ResourceTelemetryProcess): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

function processSummaryIdentityKey(process: ResourceTelemetryProcessSummary): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

function formatProcessName(process: Pick<ResourceTelemetryProcess, "command" | "name">): string {
  if (process.name.trim()) return process.name;
  const firstToken = process.command.trim().split(/\s+/)[0] ?? process.command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  return normalized.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? normalized;
}

function categoryLabel(category: ResourceTelemetryProcessCategory): string {
  switch (category) {
    case "server":
      return "Server";
    case "server-child":
      return "Backend child";
    case "provider-root":
      return "Provider";
    case "terminal-root":
      return "Terminal";
    case "electron-main":
      return "Electron main";
    case "electron-renderer":
      return "Renderer";
    case "electron-gpu":
      return "GPU";
    case "electron-utility":
      return "Electron utility";
    case "resource-monitor":
      return "Monitor";
    case "unknown-iskra":
      return "Iskra process";
  }
}

function ioSemanticsLabel(semantics: ResourceTelemetryIoSemantics): string {
  switch (semantics) {
    case "storage":
      return "Storage bytes";
    case "logical":
      return "Logical bytes";
    case "all-io":
      return "All I/O bytes";
    case "unavailable":
      return "Unavailable";
  }
}

function booleanStateLabel(
  value: BackgroundBooleanState,
  labels: { readonly true: string; readonly false: string },
): string {
  if (value === "true") return labels.true;
  if (value === "false") return labels.false;
  return "Unknown";
}

function sourceStatusTone(status: ResourceTelemetrySourceStatus): "green" | "gray" | "red" {
  if (status === "healthy") return "green";
  if (status === "starting") return "gray";
  return "red";
}

/** A collector's state as a pill: "Native healthy", or a neutral override such as "Desktop only". */
function SourceStatusBadge({
  label,
  status,
  neutralLabel,
}: {
  label?: string;
  status: ResourceTelemetrySourceStatus;
  neutralLabel?: string | undefined;
}) {
  const text = [label, neutralLabel ?? status].filter(Boolean).join(" ");
  return (
    <StatusPill
      label={text.charAt(0).toUpperCase() + text.slice(1)}
      tone={neutralLabel ? "gray" : sourceStatusTone(status)}
    />
  );
}

function LastSampleLabel({ sampledAt }: { sampledAt: DateTime.Utc | null }) {
  useRelativeTimeTick();
  if (!sampledAt) {
    return <span className="text-[11px] text-muted-foreground/55">Waiting for sample</span>;
  }
  const relative = formatRelativeTime(DateTime.formatIso(sampledAt));
  if (!relative) {
    return <span className="text-[11px] text-muted-foreground/55">Waiting for sample</span>;
  }
  return (
    <span className="text-[11px] text-muted-foreground/60">
      Updated <span className="tabular-nums">{relative.value}</span>
      {relative.suffix ? ` ${relative.suffix}` : ""}
    </span>
  );
}

/** A headline number; a notable reading adds a pill beside the label instead of coloring the digits. */
function Stat({
  label,
  value,
  detail,
  pill,
}: {
  label: string;
  value: string;
  detail?: string | undefined;
  pill?: { readonly label: string; readonly tone: "gray" | "red" } | null | undefined;
}) {
  return (
    <div className="min-w-0 px-4 py-4">
      <div className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        {pill ? <StatusPill label={pill.label} tone={pill.tone} /> : null}
      </div>
      <div className="mt-1.5 truncate text-[22px] leading-tight font-bold tabular-nums text-foreground">
        {value}
      </div>
      {detail ? (
        <div className="mt-1 truncate text-[11px] text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

function AggregateCard({
  label,
  aggregate,
}: {
  label: string;
  aggregate: ResourceTelemetryAggregate;
}) {
  return (
    <div className="border-t border-border/60 px-4 py-4 first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-semibold text-muted-foreground">{label}</div>
        <StatusPill
          label={`${aggregate.processCount} ${aggregate.processCount === 1 ? "process" : "processes"}`}
          tone="gray"
        />
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
        <MetricPair label="CPU" value={`${aggregate.currentCpuPercent.toFixed(1)}%`} />
        <MetricPair label="Memory" value={formatBytes(aggregate.currentRssBytes)} />
        <MetricPair label="Read" value={formatRate(aggregate.ioReadBytesPerSecond)} />
        <MetricPair label="Write" value={formatRate(aggregate.ioWriteBytesPerSecond)} />
      </div>
    </div>
  );
}

function MetricPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate text-xs font-medium tabular-nums text-foreground/90">{value}</div>
    </div>
  );
}

function HealthSource({ label, health }: { label: string; health: ResourceTelemetrySourceHealth }) {
  const expectedInBrowser =
    health.status === "unavailable" &&
    Option.exists(health.lastError, (error) => error.includes("'web' mode"));
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/50 py-3 first:border-t-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground/65">
          {expectedInBrowser
            ? "Available when this page runs inside the desktop app."
            : Option.match(health.lastError, {
                onNone: () => "No reported errors",
                onSome: (error) => error,
              })}
        </div>
      </div>
      <SourceStatusBadge
        status={health.status}
        neutralLabel={expectedInBrowser ? "Desktop only" : undefined}
      />
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string | undefined;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/50 py-2.5 first:border-t-0">
      <span className="text-[11px] text-muted-foreground/75">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right text-[11px] tabular-nums text-foreground/85",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}

function HistoryWindowSelector({
  selectedWindowMs,
  onSelect,
}: {
  selectedWindowMs: number;
  onSelect: (windowMs: number) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Resource history period"
      variant="segmented"
      value={[String(selectedWindowMs)]}
      onValueChange={(next) => {
        const selected = HISTORY_WINDOWS.find((option) => String(option.windowMs) === next[0]);
        if (selected) onSelect(selected.windowMs);
      }}
    >
      {HISTORY_WINDOWS.map((option) => (
        <Toggle key={option.windowMs} value={String(option.windowMs)}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function ResourceHistoryChart({
  buckets,
}: {
  buckets: ReadonlyArray<ResourceTelemetryHistoryBucket>;
}) {
  const maxCpu = resourceHistoryCpuScaleMax(buckets);
  const maxIo = Math.max(1, ...buckets.map((bucket) => bucket.ioReadBytes + bucket.ioWriteBytes));

  return (
    <div className="border-t border-border/60 px-4 py-4 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground/65">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-foreground/70" /> CPU average
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-sky-500/70" /> I/O reads
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-violet-500/70" /> I/O writes
        </span>
      </div>
      <div className="flex h-32 items-end gap-1 overflow-hidden rounded-lg border border-border/40 bg-muted/8 px-2 pt-3 pb-2">
        {buckets.map((bucket) => {
          const cpuHeight = resourceHistoryBarHeight({
            value: bucket.avgCpuPercent,
            max: maxCpu,
            minimumVisiblePercent: 2,
          });
          const readHeight = resourceHistoryBarHeight({
            value: bucket.ioReadBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });
          const writeHeight = resourceHistoryBarHeight({
            value: bucket.ioWriteBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });
          return (
            <Tooltip key={DateTime.formatIso(bucket.startedAt)}>
              <TooltipTrigger
                render={
                  <div className="grid h-full min-w-1 flex-1 grid-cols-3 items-end gap-px">
                    <span
                      className="block rounded-t-sm bg-foreground/65"
                      style={{ height: `${cpuHeight}%` }}
                    />
                    <span
                      className="block rounded-t-sm bg-sky-500/70"
                      style={{ height: `${readHeight}%` }}
                    />
                    <span
                      className="block rounded-t-sm bg-violet-500/70"
                      style={{ height: `${writeHeight}%` }}
                    />
                  </div>
                }
              />
              <TooltipPopup side="top" className="space-y-0.5 text-left">
                <div>CPU avg {bucket.avgCpuPercent.toFixed(1)}%</div>
                <div>CPU peak {bucket.maxCpuPercent.toFixed(1)}%</div>
                <div>Read {formatBytes(bucket.ioReadBytes)}</div>
                <div>Write {formatBytes(bucket.ioWriteBytes)}</div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function ProcessTreeName({
  process,
  collapsed,
  onToggle,
}: {
  process: ResourceTelemetryProcess;
  collapsed: boolean;
  onToggle: (process: ResourceTelemetryProcess) => void;
}) {
  const name = formatProcessName(process);
  const hasChildren = process.childPids.length > 0;
  const ChevronIcon = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 7) * 10}px` }}
    >
      {hasChildren ? (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={() => onToggle(process)}
          aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
        >
          <ChevronIcon className="size-3.5" />
        </Button>
      ) : (
        <span className="size-5" aria-hidden />
      )}
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(520px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px]"
        >
          {process.command || process.name}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function canSignalProcess(process: ResourceTelemetryProcess): boolean {
  return (
    process.category === "server-child" ||
    process.category === "provider-root" ||
    process.category === "terminal-root"
  );
}

function ProcessActions({
  process,
  signalingKeys,
  onSignal,
}: {
  process: ResourceTelemetryProcess;
  signalingKeys: ReadonlySet<string>;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  if (!canSignalProcess(process)) {
    return <span className="text-[11px] text-muted-foreground/35">—</span>;
  }
  const isSignaling = signalingKeys.has(processIdentityKey(process));
  return (
    <div className="flex items-center justify-end gap-1.5">
      <button
        type="button"
        disabled={isSignaling}
        className="cursor-pointer text-[11px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
        onClick={() => onSignal(process, "SIGINT")}
      >
        INT
      </button>
      <button
        type="button"
        disabled={isSignaling}
        className="cursor-pointer text-[11px] font-semibold text-destructive hover:underline disabled:opacity-50"
        onClick={() => onSignal(process, "SIGKILL")}
      >
        KILL
      </button>
    </div>
  );
}

function ProcessTable({
  processes,
  signalingKeys,
  onSignal,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcess>;
  signalingKeys: ReadonlySet<string>;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const visible = useMemo(
    () => visibleResourceTelemetryProcesses(processes, collapsed),
    [collapsed, processes],
  );
  const toggle = useCallback((process: ResourceTelemetryProcess) => {
    const identityKey = processIdentityKey(process);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(identityKey)) {
        next.delete(identityKey);
      } else {
        next.add(identityKey);
      }
      return next;
    });
  }, []);

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[min(68vh,48rem)] w-full max-w-full border-t border-border/60"
    >
      <table className="w-full min-w-[1320px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[20%]" />
          <col className="w-[10%]" />
          <col className="w-[7%]" />
          <col className="w-[8%]" />
          <col className="w-[9%]" />
          <col className="w-[9%]" />
          <col className="w-[9%]" />
          <col className="w-[10%]" />
          <col className="w-[8%]" />
          <col className="w-[6%]" />
          <col className="w-[4%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-xs font-medium text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
            <th className="px-3 py-2 font-semibold">Category</th>
            <th className="px-3 py-2 text-right font-semibold">CPU</th>
            <th className="px-3 py-2 text-right font-semibold">CPU time</th>
            <th className="px-3 py-2 text-right font-semibold">Memory</th>
            <th className="px-3 py-2 text-right font-semibold">Read/s</th>
            <th className="px-3 py-2 text-right font-semibold">Write/s</th>
            <th className="px-3 py-2 text-right font-semibold">Read total</th>
            <th className="px-3 py-2 text-right font-semibold">Write total</th>
            <th className="px-3 py-2 text-right font-semibold">PID</th>
            <th className="px-2 py-2 text-right font-semibold sm:pr-4">Kill</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {visible.length === 0 ? (
            <tr>
              <td colSpan={11} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                Waiting for the native process monitor.
              </td>
            </tr>
          ) : null}
          {visible.map((process) => (
            <tr key={processIdentityKey(process)} className="hover:bg-muted/20">
              <td className="px-4 py-2 sm:pl-5">
                <ProcessTreeName
                  process={process}
                  collapsed={collapsed.has(processIdentityKey(process))}
                  onToggle={toggle}
                />
              </td>
              <td className="truncate px-3 py-2 text-[11px] text-muted-foreground">
                {categoryLabel(process.category)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {process.cpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatCpuTime(process.cpuTimeMs)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatBytes(process.residentBytes)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatRate(process.ioReadBytesPerSecond)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatRate(process.ioWriteBytesPerSecond)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {formatBytes(process.ioReadBytes)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger render={<span>{formatBytes(process.ioWriteBytes)}</span>} />
                  <TooltipPopup side="top">{ioSemanticsLabel(process.ioSemantics)}</TooltipPopup>
                </Tooltip>
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {process.identity.pid}
              </td>
              <td className="px-2 py-2 text-right sm:pr-4">
                <ProcessActions
                  process={process}
                  signalingKeys={signalingKeys}
                  onSignal={onSignal}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function HistoryProcessTable({
  processes,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcessSummary>;
}) {
  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[28rem] w-full max-w-full border-t border-border/60"
    >
      <table className="w-full min-w-[1020px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[11%]" />
          <col className="w-[10%]" />
          <col className="w-[10%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[7%]" />
          <col className="w-[5%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-xs font-medium text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
            <th className="px-3 py-2 font-semibold">Category</th>
            <th className="px-3 py-2 text-right font-semibold">CPU time</th>
            <th className="px-3 py-2 text-right font-semibold">Peak CPU</th>
            <th className="px-3 py-2 text-right font-semibold">Peak memory</th>
            <th className="px-3 py-2 text-right font-semibold">Read</th>
            <th className="px-3 py-2 text-right font-semibold">Write</th>
            <th className="px-3 py-2 text-right font-semibold">Samples</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">PID</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {processes.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                No retained process samples in this window.
              </td>
            </tr>
          ) : null}
          {processes.map((process) => (
            <tr key={processSummaryIdentityKey(process)} className="hover:bg-muted/20">
              <td className="px-4 py-2 sm:pl-5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="block truncate font-medium text-foreground">
                        {process.name || process.command}
                      </span>
                    }
                  />
                  <TooltipPopup
                    side="top"
                    className="max-w-[min(520px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px]"
                  >
                    {process.command || process.name}
                  </TooltipPopup>
                </Tooltip>
              </td>
              <td className="truncate px-3 py-2 text-[11px] text-muted-foreground">
                {categoryLabel(process.category)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatCpuTime(process.cpuTimeMs)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {process.maxCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatBytes(process.peakRssBytes)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatBytes(process.ioReadBytes)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatBytes(process.ioWriteBytes)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {process.sampleCount}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground sm:pr-5">
                {process.identity.pid}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function AttributionTable({ entries }: { entries: ReadonlyArray<ResourceAttributionEntry> }) {
  return (
    <div className="overflow-x-auto border-t border-border/60">
      <table className="w-full min-w-[720px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[22%]" />
          <col className="w-[28%]" />
          <col className="w-[14%]" />
          <col className="w-[14%]" />
          <col className="w-[10%]" />
          <col className="w-[12%]" />
        </colgroup>
        <thead className="border-b border-border/60 text-xs font-medium text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Component</th>
            <th className="px-3 py-2 font-semibold">Operation</th>
            <th className="px-3 py-2 text-right font-semibold">Logical read</th>
            <th className="px-3 py-2 text-right font-semibold">Logical write</th>
            <th className="px-3 py-2 text-right font-semibold">Count</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {entries.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                No instrumented application I/O has been recorded yet.
              </td>
            </tr>
          ) : null}
          {entries.map((entry) => (
            <tr key={`${entry.component}:${entry.operation}`} className="hover:bg-muted/20">
              <td className="truncate px-4 py-2 font-medium text-foreground sm:pl-5">
                {entry.component}
              </td>
              <td className="truncate px-3 py-2 text-muted-foreground">{entry.operation}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatBytes(entry.logicalReadBytes)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatBytes(entry.logicalWriteBytes)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{entry.count}</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground sm:pr-5">
                {(entry.durationMs / 1_000).toFixed(2)}s
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResourceTelemetryDiagnostics({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  const [windowMs, setWindowMs] = useState(15 * 60_000);
  const selectedWindow =
    HISTORY_WINDOWS.find((option) => option.windowMs === windowMs) ?? HISTORY_WINDOWS[1];
  const telemetry = useResourceTelemetry(environmentId);
  const retryTelemetry = telemetry.retry;
  const history = useResourceTelemetryHistory(
    {
      windowMs: selectedWindow.windowMs,
      bucketMs: selectedWindow.bucketMs,
    },
    environmentId,
  );
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  });
  const [signalingKeys, setSignalingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const signalingKeysRef = useRef<ReadonlySet<string>>(new Set());
  const environmentIdRef = useRef(environmentId);
  useEffect(() => {
    environmentIdRef.current = environmentId;
    return () => {
      environmentIdRef.current = null;
    };
  }, [environmentId]);
  const [isRetrying, setIsRetrying] = useState(false);
  const snapshot = telemetry.data;
  const allIskra = snapshot?.groups.allIskra;

  const signalProcess = useCallback(
    async (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => {
      const targetEnvironmentId = environmentIdRef.current;
      if (targetEnvironmentId === null) return;
      const identityKey = processIdentityKey(process);
      if (signalingKeysRef.current.has(identityKey)) return;
      const nextSignalingKeys = new Set(signalingKeysRef.current).add(identityKey);
      signalingKeysRef.current = nextSignalingKeys;
      setSignalingKeys(nextSignalingKeys);
      const clearSignaling = () => {
        const next = new Set(signalingKeysRef.current);
        next.delete(identityKey);
        signalingKeysRef.current = next;
        setSignalingKeys(next);
      };

      if (signal === "SIGKILL") {
        let confirmed = false;
        try {
          confirmed = await ensureLocalApi().dialogs.confirm(
            `Send SIGKILL to process ${process.identity.pid}? This cannot be handled by the process.`,
            { variant: "destructive" },
          );
        } catch (error) {
          clearSignaling();
          toastManager.add({
            type: "error",
            title: "Could not confirm signal",
            description: error instanceof Error ? error.message : `Failed to send ${signal}.`,
          });
          return;
        }
        if (!confirmed) {
          clearSignaling();
          return;
        }
      }
      if (environmentIdRef.current !== targetEnvironmentId) {
        clearSignaling();
        return;
      }
      void signalServerProcess({
        environmentId: targetEnvironmentId,
        input: {
          pid: process.identity.pid,
          startTimeMs: process.identity.startTimeMs,
          signal,
        },
      })
        .then((result) => {
          if (result._tag === "Failure") {
            if (isAtomCommandInterrupted(result)) return;
            throw squashAtomCommandFailure(result);
          }
          if (result.value.signaled) return;
          toastManager.add({
            type: "error",
            title: `Could not send ${signal}`,
            description: Option.getOrElse(
              result.value.message,
              () => `Failed to send ${signal} to process ${process.identity.pid}.`,
            ),
          });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: `Could not send ${signal}`,
            description: error instanceof Error ? error.message : `Failed to send ${signal}.`,
          });
        })
        .finally(() => {
          clearSignaling();
        });
    },
    [signalServerProcess],
  );

  const retryCollector = useCallback(() => {
    setIsRetrying(true);
    void retryTelemetry()
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not restart resource monitor",
          description:
            error instanceof Error ? error.message : "The resource monitor retry failed.",
        });
      })
      .finally(() => {
        setIsRetrying(false);
      });
  }, [retryTelemetry]);

  const speedLimit = snapshot ? Option.getOrNull(snapshot.speedLimitPercent) : null;
  const collectorNeedsRetry = shouldShowResourceMonitorRetry({
    nativeStatus: snapshot?.health.native.status ?? null,
    error: telemetry.error,
  });
  const hasHostPowerSignal =
    snapshot !== null &&
    (snapshot.power.onBattery !== "unknown" ||
      snapshot.power.lowPowerMode !== "unknown" ||
      snapshot.power.idle !== "unknown" ||
      snapshot.power.locked !== "unknown" ||
      snapshot.power.thermalState !== "unknown");
  const retryButton = (
    <Button size="sm" variant="secondary" disabled={isRetrying} onClick={retryCollector}>
      <RefreshIcon className="size-3" refreshing={isRetrying} />
      Retry monitor
    </Button>
  );

  return (
    <>
      <SettingsSection
        title="Resource monitor"
        headerAction={
          <div className="flex items-center gap-2">
            {snapshot ? (
              <SourceStatusBadge label="Native" status={snapshot.health.native.status} />
            ) : null}
            <LastSampleLabel sampledAt={snapshot?.readAt ?? null} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={telemetry.isPending}
                    onClick={telemetry.refresh}
                    aria-label="Refresh resource telemetry"
                  >
                    <RefreshIcon className="size-3" refreshing={telemetry.isPending} />
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh telemetry snapshot</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <div className="overflow-hidden rounded-xl bg-card">
          <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
            <p className="min-w-0 text-xs text-muted-foreground">
              Native counters for the server, providers, terminals, desktop and the monitor.
            </p>
            {snapshot ? (
              <StatusPill
                label={`Every ${formatSampleInterval(snapshot.sampleIntervalMs)}`}
                tone="gray"
              />
            ) : null}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3">
            <Stat
              label="Current CPU"
              value={allIskra ? `${allIskra.currentCpuPercent.toFixed(1)}%` : "..."}
              detail={
                allIskra ? `${formatCpuTime(allIskra.cpuTimeMs)} observed CPU time` : undefined
              }
            />
            <Stat
              label="Resident memory"
              value={allIskra ? formatBytes(allIskra.currentRssBytes) : "..."}
              detail={
                allIskra
                  ? `${formatBytes(allIskra.peakRssBytes)} combined process peaks`
                  : undefined
              }
            />
            <Stat
              label="Process count"
              value={allIskra ? String(allIskra.processCount) : "..."}
              detail={
                allIskra
                  ? `${allIskra.processStarts} starts · ${allIskra.processExits} exits`
                  : undefined
              }
            />
            <Stat
              label="Read throughput"
              value={allIskra ? formatRate(allIskra.ioReadBytesPerSecond) : "..."}
              detail={allIskra ? `${formatBytes(allIskra.ioReadBytes)} observed` : undefined}
            />
            <Stat
              label="Write throughput"
              value={allIskra ? formatRate(allIskra.ioWriteBytesPerSecond) : "..."}
              detail={allIskra ? `${formatBytes(allIskra.ioWriteBytes)} observed` : undefined}
              pill={
                allIskra && allIskra.ioWriteBytesPerSecond >= 10 * 1_024 * 1_024
                  ? { label: "High", tone: "red" }
                  : null
              }
            />
            <Stat
              label="CPU speed limit"
              value={
                snapshot ? (speedLimit === null ? "Unknown" : `${speedLimit.toFixed(0)}%`) : "..."
              }
              detail={snapshot ? `${snapshot.power.thermalState} thermal state` : undefined}
              pill={
                speedLimit !== null && speedLimit < 80 ? { label: "Throttled", tone: "gray" } : null
              }
            />
          </div>
          {/* The monitor's error shows once, here, with its one action. */}
          {telemetry.error ? (
            <div className="flex min-h-11 items-center gap-2 border-t border-border/60 px-4 py-2 text-[13px] text-foreground">
              <AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1">{telemetry.error}</span>
              {collectorNeedsRetry ? retryButton : null}
            </div>
          ) : null}
          {snapshot ? (
            <div className="grid border-t border-border/60 md:grid-cols-3">
              <AggregateCard label="Backend + agents" aggregate={snapshot.groups.backend} />
              <AggregateCard label="Desktop" aggregate={snapshot.groups.electron} />
              <AggregateCard label="Monitor overhead" aggregate={snapshot.groups.monitor} />
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Host & collection"
        headerAction={collectorNeedsRetry && !telemetry.error ? retryButton : null}
      >
        <div className="grid overflow-hidden rounded-xl bg-card md:grid-cols-2 md:divide-x md:divide-border/60">
          <div className="px-4 py-4">
            <div className="mb-2 text-[13px] font-semibold text-muted-foreground">Host state</div>
            {hasHostPowerSignal && snapshot ? (
              <>
                <DetailRow
                  label="Power source"
                  value={booleanStateLabel(snapshot.power.onBattery, {
                    true: "Battery",
                    false: "External power",
                  })}
                />
                <DetailRow
                  label="Low power mode"
                  value={booleanStateLabel(snapshot.power.lowPowerMode, {
                    true: "Enabled",
                    false: "Disabled",
                  })}
                />
                <DetailRow
                  label="Idle"
                  value={`${booleanStateLabel(snapshot.power.idle, {
                    true: "Idle",
                    false: "Active",
                  })}${
                    snapshot.power.idleSeconds === null
                      ? ""
                      : ` · ${Math.round(snapshot.power.idleSeconds)}s`
                  }`}
                />
                <DetailRow
                  label="Session"
                  value={
                    snapshot.power.suspended
                      ? "Suspended"
                      : booleanStateLabel(snapshot.power.locked, {
                          true: "Locked",
                          false: "Unlocked",
                        })
                  }
                />
                <DetailRow
                  label="Thermal"
                  value={snapshot.power.thermalState}
                  valueClassName={
                    snapshot.power.thermalState === "serious" ||
                    snapshot.power.thermalState === "critical"
                      ? "text-destructive"
                      : undefined
                  }
                />
              </>
            ) : (
              <div className="py-2">
                <div className="text-[13px] text-foreground">
                  Desktop host signals not connected
                </div>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  Power, idle, lock and thermal state come from the desktop app.
                </p>
              </div>
            )}
          </div>
          <div className="border-t border-border/60 px-4 py-4 md:border-t-0">
            <div className="mb-2 text-[13px] font-semibold text-muted-foreground">
              Collection health
            </div>
            {snapshot ? (
              <>
                <HealthSource label="Native process monitor" health={snapshot.health.native} />
                <HealthSource label="Electron main process" health={snapshot.health.desktop} />
                <DetailRow
                  label="Collection time"
                  value={formatDurationMicros(snapshot.health.collectionDurationMicros)}
                />
                <DetailRow
                  label="Process scan"
                  value={`${snapshot.health.retainedProcessCount}/${snapshot.health.scannedProcessCount} retained`}
                />
                <DetailRow
                  label="Inaccessible"
                  value={String(snapshot.health.inaccessibleProcessCount)}
                />
                <DetailRow
                  label="Sidecar"
                  value={Option.match(snapshot.health.sidecarVersion, {
                    onNone: () => "Unavailable",
                    onSome: (version) =>
                      `${version}${Option.match(snapshot.health.sidecarPid, {
                        onNone: () => "",
                        onSome: (pid) => ` · PID ${pid}`,
                      })}`,
                  })}
                />
                <DetailRow label="Restarts" value={String(snapshot.health.restartCount)} />
              </>
            ) : (
              <div className="py-4 text-xs text-muted-foreground">
                Waiting for collector health.
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Resource timeline"
        headerAction={
          <div className="flex items-center gap-2">
            <HistoryWindowSelector selectedWindowMs={windowMs} onSelect={setWindowMs} />
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={history.isPending}
              onClick={history.refresh}
              aria-label="Refresh resource history"
            >
              <RefreshIcon className="size-3" refreshing={history.isPending} />
            </Button>
          </div>
        }
      >
        <div className="overflow-hidden rounded-xl bg-card">
          {history.error && history.error !== telemetry.error ? (
            <div className="flex min-h-11 items-center gap-2 border-b border-border/60 px-4 py-2 text-[13px] text-foreground">
              <AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
              <span className="min-w-0">{history.error}</span>
            </div>
          ) : null}
          <ResourceHistoryChart buckets={history.data?.buckets ?? []} />
          <HistoryProcessTable processes={history.data?.topProcesses ?? []} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Live process tree"
        headerAction={
          snapshot ? (
            <span className="text-[11px] text-muted-foreground">Identity: PID and start time</span>
          ) : null
        }
      >
        <div className="overflow-hidden rounded-xl bg-card">
          <ProcessTable
            processes={snapshot?.processes ?? []}
            signalingKeys={signalingKeys}
            onSignal={signalProcess}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Instrumented application I/O"
        headerAction={
          <span className="text-[11px] text-muted-foreground">Logical bytes by operation</span>
        }
      >
        <div className="overflow-hidden rounded-xl bg-card">
          <p className="flex min-h-11 items-center px-4 py-2 text-xs text-muted-foreground">
            Known Iskra operations, to match process spikes to persistence and logging.
          </p>
          <AttributionTable entries={snapshot?.attribution.entries ?? []} />
        </div>
      </SettingsSection>
    </>
  );
}
