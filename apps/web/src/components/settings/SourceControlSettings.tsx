import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ChevronDownIcon, InfoIcon } from "lucide-react";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { useEffect, useState, type ReactNode } from "react";
import type {
  BackgroundActivitySettings,
  SourceControlProviderKind,
  SourceControlDiscoveryResult,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@iskra/contracts";
import {
  getBackgroundActivityBaseProfile,
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@iskra/shared/backgroundActivitySettings";

import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { StatusPill } from "../iskra/StatusPill";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Skeleton } from "../ui/skeleton";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import {
  AzureDevOpsIcon,
  BitbucketIcon,
  GitHubIcon,
  GitIcon,
  GitLabIcon,
  ForgejoIcon,
  JujutsuIcon,
  type Icon,
} from "../Icons";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  PolicyTooltip,
  SETTINGS_NUMBER_WIDTH_CLASSNAME,
  SettingResetButton,
  SettingsEmptyRow,
  SettingsPageContainer,
  SettingsSearchTarget,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const SOURCE_CONTROL_PROVIDER_ICONS: Partial<Record<SourceControlProviderKind, Icon>> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  forgejo: ForgejoIcon,
  "azure-devops": AzureDevOpsIcon,
  bitbucket: BitbucketIcon,
};

const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
  jj: JujutsuIcon,
};

const SOURCE_CONTROL_SKELETON_ROWS = ["primary", "secondary"] as const;
const GIT_FETCH_INTERVAL_STEP_SECONDS = 5;
type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

function normalizeFetchIntervalSeconds(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    ...current.overrides,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function isProviderDiscoveryItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): item is SourceControlProviderDiscoveryItem {
  return "auth" in item;
}

function isVcsNotReady(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): boolean {
  return !isProviderDiscoveryItem(item) && !item.implemented;
}

function RedactedAccount(props: { readonly account: string | null }) {
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel="Toggle source control account visibility"
      revealTooltip="Click to reveal account"
      hideTooltip="Click to hide account"
    />
  );
}

/** One status pill per tool: green when usable, gray otherwise (none of these needs a person). */
function itemStatus(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): {
  readonly label: string;
  readonly tone: "green" | "gray";
} {
  if (isVcsNotReady(item)) return { label: "Coming soon", tone: "gray" };
  if (item.status !== "available") return { label: "Not installed", tone: "gray" };
  if (!isProviderDiscoveryItem(item)) return { label: "Available", tone: "green" };
  if (item.auth.status === "authenticated") return { label: "Signed in", tone: "green" };
  if (item.auth.status === "unauthenticated") return { label: "Not signed in", tone: "gray" };
  return { label: "Status unknown", tone: "gray" };
}

/** Install and sign-in help, with backticked commands rendered as code. */
function HintText({ text }: { readonly text: string }) {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      // oxlint-disable-next-line react/no-array-index-key -- static split of one string
      <code key={index} className="rounded bg-muted px-1 py-px text-[11px]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** The longer install or sign-in explanation, shown behind the row's info button. */
function itemHelp(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): string | null {
  if (isVcsNotReady(item)) return null;
  if (item.status !== "available") return item.installHint;
  if (!isProviderDiscoveryItem(item) || item.auth.status === "authenticated") return null;
  if (!item.executable) return item.installHint;
  if (item.auth.status === "unauthenticated") {
    return `Sign in or configure credentials with \`${item.executable}\` on the server host to enable change request features.`;
  }
  return `Could not verify ${item.label}. ${optionLabel(item.auth.detail) ?? item.installHint}`;
}

function DiscoveryItemRow({
  item,
  children,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly children?: ReactNode;
}) {
  const version = optionLabel(item.version);
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authAccount = auth?.status === "authenticated" ? optionLabel(auth.account) : null;
  const status = itemStatus(item);
  const help = itemHelp(item);
  const Icon = isProviderDiscoveryItem(item)
    ? SOURCE_CONTROL_PROVIDER_ICONS[item.kind]
    : VCS_ICONS[item.kind];
  const [isExpanded, setIsExpanded] = useState(false);
  const hasDetails = children !== undefined;
  const searchTargetId = useSettingsSearchTargetId();

  useEffect(() => {
    if (item.kind === "git" && searchTargetId === searchableSetting("git-fetch-interval").id) {
      setIsExpanded(true);
    }
  }, [item.kind, searchTargetId]);

  return (
    <div data-slot="settings-row">
      <div className="flex min-h-11 items-center gap-3 px-4 py-2">
        {Icon ? (
          <Icon className="size-4 shrink-0 text-foreground/80" aria-hidden />
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-h-5 min-w-0 items-center gap-1.5">
            <h3 className="truncate text-[13px] text-foreground">{item.label}</h3>
            {help ? (
              <Tooltip>
                <TooltipTrigger
                  delay={200}
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-label={`About ${item.label}`}
                    >
                      <InfoIcon className="size-3" />
                    </Button>
                  }
                />
                <TooltipPopup side="top" className="max-w-80">
                  <HintText text={help} />
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          {version || authAccount ? (
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {version ? <code className="truncate text-[11px]">{version}</code> : null}
              {version && authAccount ? <span aria-hidden>·</span> : null}
              {authAccount ? <RedactedAccount account={authAccount} /> : null}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill label={status.label} tone={status.tone} />
          {hasDetails ? (
            <Button
              size="icon-sm"
              variant="ghost-muted"
              onClick={() => setIsExpanded((open) => !open)}
              aria-expanded={isExpanded}
              aria-label={`Toggle ${item.label} details`}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
              />
            </Button>
          ) : null}
        </div>
      </div>

      {hasDetails ? (
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleContent>
            <div className="px-4 pb-3 sm:pl-11">{children}</div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function GitFetchIntervalSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const defaultAutomaticGitFetchIntervalSeconds = durationToSeconds(
    getBackgroundActivityPresetSettings(
      getBackgroundActivityBaseProfile(settings.backgroundActivity),
    ).automaticGitFetchInterval,
  );
  const canResetFetchInterval =
    automaticGitFetchIntervalSeconds !== defaultAutomaticGitFetchIntervalSeconds;
  const setting = searchableSetting("git-fetch-interval");

  return (
    <SettingsSearchTarget id={setting.id} className="grid gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-1">
            <span className="text-[13px] text-foreground">{setting.title}</span>
            <PolicyTooltip>
              This interval is configured for Git only. The shared Background activity policy still
              decides whether Git refreshes may run when the timer fires. Custom intervals appear as
              Advanced in General settings.
            </PolicyTooltip>
            <span
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center transition-opacity",
                canResetFetchInterval ? "opacity-100" : "pointer-events-none opacity-0",
              )}
              aria-hidden={!canResetFetchInterval}
            >
              {canResetFetchInterval ? (
                <SettingResetButton
                  label="fetch interval"
                  onClick={() =>
                    updateSettings(
                      backgroundActivityOverrideSettings(settings.backgroundActivity, {
                        automaticGitFetchInterval: undefined,
                      }),
                    )
                  }
                />
              ) : null}
            </span>
          </div>
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Refresh remote branches in the background. Set to 0 to avoid automatic Git prompts.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <NumberField
            value={automaticGitFetchIntervalSeconds}
            min={0}
            step={GIT_FETCH_INTERVAL_STEP_SECONDS}
            size="sm"
            className={SETTINGS_NUMBER_WIDTH_CLASSNAME}
            onValueChange={(value) =>
              updateSettings(
                backgroundActivityOverrideSettings(settings.backgroundActivity, {
                  automaticGitFetchInterval: Duration.seconds(normalizeFetchIntervalSeconds(value)),
                }),
              )
            }
          >
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="Decrease fetch interval" />
              <NumberFieldInput aria-label="Automatic Git fetch interval in seconds" />
              <NumberFieldIncrement aria-label="Increase fetch interval" />
            </NumberFieldGroup>
          </NumberField>
          <span className="text-xs text-muted-foreground">seconds</span>
        </div>
      </div>
    </SettingsSearchTarget>
  );
}

function SourceControlSectionSkeleton({
  title,
  headerAction,
}: {
  readonly title: string;
  readonly headerAction?: ReactNode;
}) {
  return (
    <SettingsSection title={title} headerAction={headerAction}>
      {SOURCE_CONTROL_SKELETON_ROWS.map((row) => (
        <div key={row} className="flex min-h-11 items-center gap-3 px-4 py-2">
          <Skeleton className="size-4 rounded-md" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-28 rounded-full" />
            <Skeleton className="h-3 w-40 rounded-full" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </SettingsSection>
  );
}

function EmptySourceControlDiscovery({
  error,
  isPending,
  onScan,
}: {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onScan: () => void;
}) {
  return (
    <SettingsSection id={searchableSetting("source-control").id} title="Server environment">
      <SettingsEmptyRow
        action={
          <Button size="sm" variant="secondary" onClick={onScan} disabled={isPending}>
            <RefreshIcon className="size-3.5" refreshing={isPending} />
            Scan
          </Button>
        }
      >
        {error !== null
          ? `Could not scan the server environment. ${error}`
          : "Nothing detected. Install Git on the server, then scan again."}
      </SettingsEmptyRow>
    </SettingsSection>
  );
}

export function SourceControlSettingsPanel() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  // Discovery scans one machine's tools, so it shows the representative
  // environment (named in the section title when several are selected);
  // the settings rows above it fan out like everywhere else.
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  const environmentSuffix = aggregate && environment ? ` · ${environment.label}` : "";
  const discovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId,
          input: {},
        }),
  );
  const result = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const hasVersionControlSystems = result.versionControlSystems.length > 0;
  const hasDiscoveryItems = hasVersionControlSystems || result.sourceControlProviders.length > 0;
  const isInitialScanPending = discovery.isPending && discovery.data === null;
  const handleScan = () => {
    discovery.refresh();
  };
  const scanButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            onClick={handleScan}
            disabled={discovery.isPending}
            aria-label="Rescan server environment"
          >
            <RefreshIcon refreshing={discovery.isPending} />
          </Button>
        }
      />
      <TooltipPopup side="top">Rescan Git and hosting integrations</TooltipPopup>
    </Tooltip>
  );

  return (
    <SettingsPageContainer>
      <ProjectDefaultsSettings category="source-control" />
      {environmentId === null ? (
        <SettingsSection id={searchableSetting("source-control").id} title="Server environment">
          <SettingsEmptyRow>
            Connect an environment to see its Git tools and hosts.
          </SettingsEmptyRow>
        </SettingsSection>
      ) : isInitialScanPending ? (
        <>
          <SourceControlSectionSkeleton
            title={`Version control${environmentSuffix}`}
            headerAction={scanButton}
          />
          <SourceControlSectionSkeleton title="Source control providers" />
        </>
      ) : hasDiscoveryItems ? (
        <>
          {hasVersionControlSystems ? (
            <SettingsSection
              id={searchableSetting("source-control").id}
              title={`Version control${environmentSuffix}`}
              headerAction={scanButton}
            >
              {result.versionControlSystems.map((item) => (
                <DiscoveryItemRow key={`vcs:${item.kind}`} item={item}>
                  {item.kind === "git" ? <GitFetchIntervalSettings /> : undefined}
                </DiscoveryItemRow>
              ))}
            </SettingsSection>
          ) : null}

          {result.sourceControlProviders.length > 0 ? (
            <SettingsSection
              id={hasVersionControlSystems ? undefined : searchableSetting("source-control").id}
              title={
                hasVersionControlSystems
                  ? "Source control providers"
                  : `Source control providers${environmentSuffix}`
              }
              headerAction={hasVersionControlSystems ? null : scanButton}
            >
              {result.sourceControlProviders.map((item) => (
                <DiscoveryItemRow key={`provider:${item.kind}`} item={item} />
              ))}
            </SettingsSection>
          ) : null}
        </>
      ) : (
        <EmptySourceControlDiscovery
          error={discovery.error}
          isPending={discovery.isPending}
          onScan={handleScan}
        />
      )}

      <SourceControlWritingSettingsSection />
    </SettingsPageContainer>
  );
}
