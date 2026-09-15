import { InfoIcon, Undo2Icon } from "lucide-react";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@iskra/contracts";
import * as Equal from "effect/Equal";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE,
  usePrimarySettingsAvailable,
} from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { WorkspacePageContainer, type WorkspacePageWidth } from "../WorkspacePageContainer";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { settingsPageTitle } from "./settingsSearch";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import {
  isProjectScopedSettingKey,
  listProjectOverrides,
  scopedSettingsAreMixed,
  scopedSettingsSource,
} from "./scopedSettings";
import { useClearProjectOverrides, useClearScopedSettings } from "./useScopedSettings";
import {
  SettingInheritance,
  type SettingInheritanceState,
  type SettingOverridingProject,
} from "./SettingInheritance";

const EMPTY_SETTING_KEYS: readonly (keyof ServerSettings)[] = [];

declare module "@tanstack/react-router" {
  interface HistoryState {
    settingsTargetHighlight?: boolean;
  }
}

interface SettingsSearchTargetContextValue {
  readonly targetId: string | null;
  readonly highlightTarget: boolean;
  readonly onTargetHandled: () => void;
}

const noop = () => undefined;
const SettingsSearchTargetContext = createContext<SettingsSearchTargetContextValue>({
  targetId: null,
  highlightTarget: true,
  onTargetHandled: noop,
});

export function SettingsSearchTargetProvider({
  targetId,
  highlightTarget = true,
  onTargetHandled = noop,
  children,
}: {
  targetId: string | null;
  highlightTarget?: boolean;
  onTargetHandled?: () => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ targetId, highlightTarget, onTargetHandled }),
    [highlightTarget, onTargetHandled, targetId],
  );
  return <SettingsSearchTargetContext value={value}>{children}</SettingsSearchTargetContext>;
}

function scrollAndFocusSettingsTarget(target: HTMLElement, highlight = true): void {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const markedScrollTarget =
    typeof target.querySelector === "function"
      ? target.querySelector<HTMLElement>(":scope > [data-settings-scroll-target]")
      : null;
  const scrollTarget =
    markedScrollTarget ??
    (target.tagName === "SECTION" && target.firstElementChild
      ? (target.firstElementChild as HTMLElement)
      : target);

  scrollTarget.scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth",
    block: "center",
  });
  target.focus({ preventScroll: true });
  target.classList.remove("settings-search-target-pulse");
  if (!highlight || prefersReducedMotion) return;
  void target.offsetWidth;
  target.classList.add("settings-search-target-pulse");
  // The class also suppresses the focus outline (the pulse is the destination
  // indicator), so drop it once the element is no longer the destination.
  target.addEventListener("blur", () => target.classList.remove("settings-search-target-pulse"), {
    once: true,
  });
}

/** The row id a settings-search jump is currently trying to reach, if any. */
export function useSettingsSearchTargetId(): string | null {
  return useContext(SettingsSearchTargetContext).targetId;
}

export function useSettingsSearchTarget<T extends HTMLElement>(id: string | undefined) {
  const { targetId, highlightTarget, onTargetHandled } = useContext(SettingsSearchTargetContext);
  const isSearchTarget = id !== undefined && id === targetId;
  const targetRef = useCallback(
    (target: T | null) => {
      if (target && isSearchTarget) {
        scrollAndFocusSettingsTarget(target, highlightTarget);
        onTargetHandled();
      }
    },
    [highlightTarget, isSearchTarget, onTargetHandled],
  );

  return targetRef;
}

export function SettingsSearchTarget({
  children,
  ...targetProps
}: ComponentPropsWithoutRef<"div">) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(targetProps.id);
  return (
    <div {...targetProps} ref={targetRef} tabIndex={targetProps.id ? -1 : targetProps.tabIndex}>
      {children}
    </div>
  );
}

/**
 * Trigger classes for the composer model/traits pickers when they sit in a
 * settings row: match the `sm` control box (the composer pins them to 28px at
 * every breakpoint) and drop the composer's max-width.
 */
export const SETTINGS_PICKER_TRIGGER_CLASSNAME =
  "h-8 min-h-8 min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground sm:h-7 sm:min-h-7";

/** Info affordance explaining how a setting interacts with the shared background policy. */
export function PolicyTooltip({ children }: { readonly children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button size="icon-micro" variant="ghost-muted" aria-label="Background policy details">
            <InfoIcon className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {children}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Re-render every `intervalMs`; return a stable timestamp snapshot for render-time relative labels. */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

/** Hairline between grouped rows, inset from the leading edge like a macOS grouped list. */
export const SETTINGS_GROUP_ROWS_CLASSNAME =
  "[&>*+*]:bg-[linear-gradient(var(--border),var(--border))] [&>*+*]:bg-[length:calc(100%-1rem)_0.5px] [&>*+*]:bg-right-top [&>*+*]:bg-no-repeat";

/** A grouped inset list: 12px corners on the card surface, rows split by inset hairlines. */
export const SETTINGS_GROUP_CLASSNAME = `rounded-xl bg-card text-card-foreground ${SETTINGS_GROUP_ROWS_CLASSNAME}`;

/** Section heads: 13px semibold secondary text over the group. */
export const SETTINGS_SECTION_HEAD_CLASSNAME =
  "flex min-h-6 items-center gap-2 text-[13px] font-semibold text-muted-foreground";

/** The large page title shared by settings and the other workspace pages. */
export function SettingsLargeTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1
      className={cn(
        "text-[28px] leading-tight font-bold tracking-[-0.02em] text-foreground",
        className,
      )}
    >
      {children}
    </h1>
  );
}

const SETTINGS_CAPTION_MAX_LENGTH = 84;

/**
 * A setting's caption fits one secondary line. A longer explanation keeps its
 * first sentence inline (or an ellipsized line) and moves whole behind the
 * row's info button. Rich captions render as given.
 */
export function splitSettingDescription(description: ReactNode): {
  readonly inline: ReactNode;
  readonly full: string | null;
} {
  if (typeof description !== "string") return { inline: description, full: null };
  const text = description.trim();
  if (text.length <= SETTINGS_CAPTION_MAX_LENGTH) return { inline: text, full: null };
  const firstSentence = /^.+?[.!?](?=\s)/.exec(text)?.[0];
  return {
    inline:
      firstSentence !== undefined && firstSentence.length <= SETTINGS_CAPTION_MAX_LENGTH
        ? firstSentence
        : text,
    full: text,
  };
}

/** Muted section headings have no descriptions; explanatory copy belongs to individual settings. */
export function SettingsSection({
  title,
  hideTitle = false,
  icon,
  headerAction,
  variant = "grouped",
  children,
  className,
  ...sectionProps
}: ComponentPropsWithoutRef<"section"> & {
  title: string;
  hideTitle?: boolean;
  icon?: ReactNode;
  headerAction?: ReactNode;
  variant?: "grouped" | "plain";
  children: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(sectionProps.id);

  return (
    <section
      {...sectionProps}
      ref={targetRef}
      tabIndex={sectionProps.id ? -1 : sectionProps.tabIndex}
      className={cn(!hideTitle && "space-y-2", className)}
    >
      {hideTitle ? (
        <h2 className="sr-only">{title}</h2>
      ) : (
        <div
          data-settings-scroll-target
          className="flex min-h-7 items-end justify-between gap-4 px-4"
        >
          <div className="min-w-0">
            <h2 className={SETTINGS_SECTION_HEAD_CLASSNAME}>
              {icon}
              {title}
            </h2>
          </div>
          <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
        </div>
      )}
      <div
        data-settings-scroll-target={hideTitle ? "" : undefined}
        className={cn(
          "relative overflow-visible text-foreground",
          variant === "grouped"
            ? cn(SETTINGS_GROUP_CLASSNAME, "[&>[data-slot=settings-row]]:rounded-none")
            : "space-y-1",
        )}
      >
        {children}
      </div>
    </section>
  );
}

export function SettingsUnavailableGroup({
  children,
  message,
}: {
  children: ReactNode;
  message?: ReactNode;
}) {
  if (message === undefined) return children;

  return (
    <div className="border-border/60 bg-muted/20 py-1.5">
      <div className="flex items-start gap-2 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground sm:px-4">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p>{message}</p>
      </div>
      <div className="[&_h3]:opacity-64 [&_p]:opacity-64">{children}</div>
    </div>
  );
}

/**
 * One setting. `serverScoped` marks rows whose value lives in the primary
 * environment's settings.json; where there is no primary (the hosted app)
 * the control goes inert with a tooltip instead of showing an editable
 * default that would never save.
 *
 * Keep descriptions short enough for one line where possible. Allow wrapping
 * for clarity or narrow screens instead of truncating or forcing no-wrap.
 *
 * Control sizing across settings follows three tiers so rows share a baseline:
 * - `control` slot: `size="sm"` (Button, Select, Input, NumberField) or `icon-sm`.
 * - Section `headerAction`s and buttons inside list items, cards, toolbars: `xs` / `icon-xs`.
 * - Inline affordances (reset arrows, info tooltips, table-cell buttons): `icon-micro`.
 * Dialog footers keep the app-wide default button size.
 */
export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  onResetOverride,
  control,
  serverScoped = false,
  settingKeys = EMPTY_SETTING_KEYS,
  mixed: mixedOverride,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  /** Replaces the default override clear for rows with side effects beyond the settings key. */
  onResetOverride?: () => void;
  control?: ReactNode;
  serverScoped?: boolean;
  settingKeys?: readonly (keyof ServerSettings)[];
  mixed?: boolean;
  children?: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(rowProps.id);
  const primarySettingsAvailable = usePrimarySettingsAvailable();
  const context = useOptionalSettingsScope();
  const clearOverrides = useClearScopedSettings();
  const clearProjectOverrides = useClearProjectOverrides();
  const isProjectScope =
    context !== null && (context.scope.kind === "project" || context.scope.kind === "checkout");
  const scopedKeys = settingKeys.filter(isProjectScopedSettingKey);
  // A project scope can only edit keys that support overrides; the rest stay
  // visible so the user sees the inherited value, but cannot change it here.
  const environmentWide = isProjectScope && serverScoped && scopedKeys.length === 0;
  const mixed =
    mixedOverride ?? (context !== null && scopedSettingsAreMixed(context.targets, settingKeys));
  const source =
    context && isProjectScope ? scopedSettingsSource(context.targets, scopedKeys) : null;
  const unavailable =
    serverScoped &&
    !(context ? context.connectedEnvironments.length > 0 : primarySettingsAvailable);
  const inheritedFrom =
    source === "environment" && context?.scope.environmentIds.length === 1
      ? (context.environments.find(
          (environment) => environment.environmentId === context.scope.environmentIds[0],
        )?.label ?? "environment")
      : "environment";
  const environmentSettingsById = useMemo(
    () =>
      new Map(
        (context?.connectedEnvironments ?? []).flatMap((environment) =>
          environment.serverConfig
            ? [[environment.environmentId, environment.serverConfig.settings] as const]
            : [],
        ),
      ),
    [context?.connectedEnvironments],
  );
  // At environment scope, projects with their own value keep it when the
  // environment default changes; the chain names them and can reset them.
  const overridingProjects = useMemo((): SettingOverridingProject[] => {
    if (context === null || isProjectScope || scopedKeys.length === 0) return [];
    return listProjectOverrides(context.connectedEnvironments, scopedKeys).flatMap((entry) => {
      const group = context.groups.find((candidate) =>
        candidate.memberProjects.some(
          (member) => member.environmentId === entry.environmentId && member.id === entry.projectId,
        ),
      );
      if (!group) return [];
      return [
        {
          ...entry,
          label: group.displayName,
          open: () =>
            context.selectScope({
              project: group.projectKey,
              ...(context.search.machine ? { machine: context.search.machine } : {}),
            }),
        },
      ];
    });
  }, [context, isProjectScope, scopedKeys]);
  const renderedReset = unavailable ? null : isProjectScope && scopedKeys.length > 0 ? (
    source === "project" || source === "mixed" ? (
      <SettingResetButton
        label={typeof title === "string" ? title : "override"}
        tooltip="Reset to inherited value"
        onClick={() => (onResetOverride ? onResetOverride() : clearOverrides(scopedKeys))}
      />
    ) : null
  ) : (
    resetAction
  );
  const inertControl = (message: string) => (
    <Tooltip>
      <TooltipTrigger
        render={
          // Focusable so keyboard users can still reach the explanation.
          <span
            tabIndex={0}
            className="flex w-full items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
          />
        }
      >
        <div inert className="flex w-full items-center gap-2 opacity-50 sm:w-auto">
          {control}
        </div>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {message}
      </TooltipPopup>
    </Tooltip>
  );
  // A mixed selection keeps the real control with "Mixed" as its placeholder
  // (the multi-selection inspector convention): the popover shows who has
  // what, and picking a value applies it to every target.
  const renderedControl =
    unavailable && control
      ? inertControl(
          context
            ? "Reconnect the selected environment to change this setting."
            : PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE,
        )
      : environmentWide && control
        ? inertControl("Environment-wide setting. Select an environment to change it.")
        : control;
  // Server rows get an indicator beside the title that opens the resolution
  // chain per target at every scope; client rows keep a plain status only.
  const customized =
    context !== null &&
    settingKeys.some((key) =>
      context.targets.some((candidate) => {
        const environmentSettings = environmentSettingsById.get(candidate.environmentId);
        return (
          environmentSettings !== undefined &&
          !Equal.equals(environmentSettings[key], DEFAULT_SERVER_SETTINGS[key])
        );
      }),
    );
  const inheritance: { state: SettingInheritanceState; summary: string } = mixed
    ? { state: "mixed", summary: "Mixed across selected environments" }
    : source === "project"
      ? { state: "overridden", summary: "Overridden for this project" }
      : source === "environment" && scopedKeys.length > 0
        ? { state: "inherited", summary: `Inherited from ${inheritedFrom}` }
        : customized
          ? { state: "environment", summary: "Set on the environment" }
          : { state: "default", summary: "Built-in default" };
  const renderedInheritance =
    context && serverScoped && settingKeys.length > 0 ? (
      <SettingInheritance
        state={inheritance.state}
        summary={inheritance.summary}
        targets={context.targets}
        environments={context.connectedEnvironments}
        keys={settingKeys}
        overridingProjects={overridingProjects}
        onClearOverrides={(entries) => clearProjectOverrides(entries, scopedKeys)}
      />
    ) : null;
  const renderedStatus = status;
  const caption = splitSettingDescription(description);

  return (
    <div
      {...rowProps}
      ref={targetRef}
      tabIndex={rowProps.id ? -1 : rowProps.tabIndex}
      data-slot="settings-row"
      className={cn(
        "flex min-h-11 flex-col justify-center rounded-xl px-4 aria-disabled:opacity-50 aria-disabled:[&_*]:text-muted-foreground",
        children ? "pt-2.5 pb-1" : "py-2",
        className,
      )}
    >
      <div className="flex flex-col gap-2.5 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] sm:items-center sm:gap-6">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-[13px] font-normal text-foreground">{title}</h3>
            {caption.full ? (
              <Tooltip>
                <TooltipTrigger
                  delay={200}
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-label={`About ${typeof title === "string" ? title : "this setting"}`}
                    >
                      <InfoIcon className="size-3" />
                    </Button>
                  }
                />
                <TooltipPopup side="top" className="max-w-72">
                  {caption.full}
                </TooltipPopup>
              </Tooltip>
            ) : null}
            {renderedInheritance ? (
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                {renderedInheritance}
              </span>
            ) : null}
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {renderedReset}
            </span>
          </div>
          {caption.inline ? (
            <p
              className={cn(
                "max-w-xl text-xs leading-4 text-muted-foreground",
                typeof caption.inline === "string" && "truncate",
              )}
            >
              {caption.inline}
            </p>
          ) : null}
          {renderedStatus ? (
            <div className="text-xs text-muted-foreground">{renderedStatus}</div>
          ) : null}
        </div>
        {renderedControl ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {renderedControl}
          </div>
        ) : null}
      </div>
      {unavailable && children ? (
        <div inert className="opacity-50">
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export function SettingResetButton({
  label,
  tooltip = "Reset to default",
  disabled = false,
  onClick,
}: {
  label: string;
  tooltip?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={`Reset ${label} to default`}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The scrolling frame of a settings page. It opens with the page's large title,
 * named after the settings section unless `title` names something narrower.
 */
export function SettingsPageContainer({
  children,
  className,
  title,
  width = "readable",
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  width?: WorkspacePageWidth;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const pageTitle = title ?? settingsPageTitle(pathname);
  const hash = useLocation({ select: (location) => location.hash });
  const highlightTarget = useLocation({
    select: (location) => location.state.settingsTargetHighlight !== false,
  });
  const targetId = hash.replace(/^#/, "") || null;
  const clearTargetHash = useCallback(() => {
    void navigate({
      hash: "",
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: true },
    });
  }, [navigate]);

  return (
    <SettingsSearchTargetProvider
      targetId={targetId}
      highlightTarget={highlightTarget}
      onTargetHandled={clearTargetHash}
    >
      <div
        className="topbar-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto"
        data-settings-page-scroll
      >
        <WorkspacePageContainer
          width={width}
          className={cn("gap-7 pt-2", width === "readable" && "max-w-[46rem]", className)}
        >
          {pageTitle ? <SettingsLargeTitle>{pageTitle}</SettingsLargeTitle> : null}
          {children}
        </WorkspacePageContainer>
      </div>
    </SettingsSearchTargetProvider>
  );
}

export function scrollToSettingsTarget(
  targetId: string,
  { highlight = true }: { readonly highlight?: boolean } = {},
): boolean {
  const target = document.getElementById(targetId);
  if (!target) return false;
  scrollAndFocusSettingsTarget(target, highlight);
  return true;
}
