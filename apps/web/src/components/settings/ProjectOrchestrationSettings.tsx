import {
  projectOrchestrationOf,
  type CardRuntimeSettings as CardRuntimeSettingsValue,
  type EnvironmentId,
  type ProjectOrchestration,
} from "@iskra/contracts";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import type { Project } from "~/types";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Publishing and billing APIs agent shells should never reach from a social-publishing product. */
const PUBLISHING_DENY_TEMPLATE = [
  "graph.facebook.com",
  "graph.instagram.com",
  "graph.threads.net",
  "open.tiktokapis.com",
  "api.x.com",
  "api.apify.com",
  "api.paddle.com",
  "api.resend.com",
];

const LANDING_LABEL = {
  auto: "Automatic",
  pullRequest: "Pull request",
  local: "Local fast-forward",
};
type LandingChoice = keyof typeof LANDING_LABEL;

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** A whole number at least `min`, or null when the text isn't one. Blank reads as `blank`. */
function wholeNumber<B>(text: string, min: number, blank: B): number | B | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return blank;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= min ? value : null;
}

interface PolicyForm {
  readonly baseBranch: string;
  readonly sessionCap: string;
  readonly openAgentPrCap: string;
  readonly landing: LandingChoice;
  readonly ciFixRounds: string;
  readonly reviewFixRounds: string;
  readonly checksWaived: boolean;
  readonly egressMode: ProjectOrchestration["egress"]["mode"];
  readonly allow: string;
  readonly deny: string;
  readonly exclusivePaths: string;
  readonly heavyCommands: string;
  readonly builderSubCardsMax: string;
}

function formOf(policy: ProjectOrchestration): PolicyForm {
  return {
    baseBranch: policy.baseBranch ?? "",
    sessionCap: policy.sessionCap === null ? "" : String(policy.sessionCap),
    openAgentPrCap: String(policy.openAgentPrCap),
    landing: policy.landing ?? "auto",
    ciFixRounds: String(policy.ciFixRounds),
    reviewFixRounds: String(policy.reviewFixRounds),
    checksWaived: policy.checksWaived,
    egressMode: policy.egress.mode,
    allow: policy.egress.allow.join("\n"),
    deny: policy.egress.deny.join("\n"),
    exclusivePaths: policy.exclusivePaths
      .map((entry) =>
        entry.afterRebase === null ? entry.glob : `${entry.glob} => ${entry.afterRebase}`,
      )
      .join("\n"),
    heavyCommands: policy.heavyCommands.join("\n"),
    builderSubCardsMax: String(policy.builderSubCardsMax),
  };
}

/** The policy a form describes on top of `base`, or the first field that doesn't read. */
function policyOf(
  form: PolicyForm,
  base: ProjectOrchestration,
): { readonly policy: ProjectOrchestration } | { readonly error: string } {
  const sessionCap = wholeNumber(form.sessionCap, 1, null);
  const openAgentPrCap = wholeNumber(form.openAgentPrCap, 1, undefined);
  const ciFixRounds = wholeNumber(form.ciFixRounds, 0, undefined);
  const reviewFixRounds = wholeNumber(form.reviewFixRounds, 0, undefined);
  const builderSubCardsMax = wholeNumber(form.builderSubCardsMax, 1, undefined);
  if (form.sessionCap.trim().length > 0 && sessionCap === null) {
    return { error: "The session cap is a whole number of at least 1, or blank." };
  }
  if (typeof openAgentPrCap !== "number")
    return { error: "Open agent pull requests is a whole number of at least 1." };
  if (typeof ciFixRounds !== "number" || typeof reviewFixRounds !== "number") {
    return { error: "Fix rounds are whole numbers, 0 or more." };
  }
  if (typeof builderSubCardsMax !== "number")
    return { error: "Sub-cards is a whole number of at least 1." };
  const allow = lines(form.allow);
  const deny = lines(form.deny);
  const overlap = allow.find((domain) => deny.includes(domain));
  if (overlap !== undefined) return { error: `${overlap} is both allowed and denied.` };
  return {
    policy: {
      ...base,
      baseBranch: form.baseBranch.trim().length === 0 ? null : form.baseBranch.trim(),
      sessionCap: typeof sessionCap === "number" ? sessionCap : null,
      openAgentPrCap,
      landing: form.landing === "auto" ? null : form.landing,
      ciFixRounds,
      reviewFixRounds,
      checksWaived: form.checksWaived,
      egress: { mode: form.egressMode, allow, deny },
      exclusivePaths: lines(form.exclusivePaths).map((line) => {
        const [glob = "", afterRebase = ""] = line.split("=>").map((part) => part.trim());
        return { glob, afterRebase: afterRebase.length === 0 ? null : afterRebase };
      }),
      heavyCommands: lines(form.heavyCommands),
      builderSubCardsMax,
    },
  };
}

/**
 * A project's orchestration policy: what the decider enforces for its cards and what agent shells
 * may reach. Only a person sets it here; it is saved to every checkout of the project shown.
 */
export function ProjectOrchestrationSettings(props: { readonly members: ReadonlyArray<Project> }) {
  const representative = props.members[0];
  if (representative === undefined) return null;
  const current = projectOrchestrationOf(representative);
  // Remounting on a saved change resets the form to what the server now holds.
  return (
    <ProjectOrchestrationForm
      key={JSON.stringify(current)}
      members={props.members}
      representative={representative}
      current={current}
      mixed={props.members.some(
        (member) => JSON.stringify(projectOrchestrationOf(member)) !== JSON.stringify(current),
      )}
    />
  );
}

function ProjectOrchestrationForm(props: {
  readonly members: ReadonlyArray<Project>;
  readonly representative: Project;
  readonly current: ProjectOrchestration;
  readonly mixed: boolean;
}) {
  const { current } = props;
  const setOrchestration = useAtomCommand(cardEnvironment.setOrchestration);
  const [form, setForm] = useState(() => formOf(current));
  const [saving, setSaving] = useState(false);
  const change = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  const parsed = policyOf(form, current);
  const edited = "policy" in parsed && JSON.stringify(parsed.policy) !== JSON.stringify(current);

  const save = async (policy: ProjectOrchestration) => {
    setSaving(true);
    for (const member of props.members) {
      const result = await setOrchestration({
        environmentId: member.environmentId,
        input: { projectId: member.id, orchestration: policy },
      });
      toastCommandFailure(
        result,
        "The orchestration policy was not saved",
        "The request was refused.",
      );
      if (result._tag !== "Success") break;
    }
    setSaving(false);
  };

  return (
    <>
      <SettingsSection id="project-orchestration" title="Agent orchestration">
        {props.mixed ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">
            This project's checkouts have different policies; saving applies this one to all.
          </p>
        ) : null}
        <SettingsRow
          title="Base branch"
          description="Cards start from and land into it. Blank uses the repository's default branch."
          control={
            <Input
              size="sm"
              className="w-full sm:w-48"
              aria-label="Base branch"
              placeholder="Default branch"
              value={form.baseBranch}
              onChange={(event) => change("baseBranch", event.target.value)}
            />
          }
        />
        <SettingsRow
          title="Session cap"
          description="Agent sessions working at once in this project. It can only lower this machine's cap; blank leaves the machine's."
          control={
            <Input
              size="sm"
              className="w-24"
              aria-label="Session cap"
              inputMode="numeric"
              placeholder="Machine"
              value={form.sessionCap}
              onChange={(event) => change("sessionCap", event.target.value)}
            />
          }
        />
        <SettingsRow
          title="Open agent pull requests"
          description="New cards wait while this many agent pull requests wait on a person."
          control={
            <Input
              size="sm"
              className="w-24"
              aria-label="Open agent pull request cap"
              inputMode="numeric"
              value={form.openAgentPrCap}
              onChange={(event) => change("openAgentPrCap", event.target.value)}
            />
          }
        />
        <SettingsRow
          title="Landing"
          description="Automatic opens a pull request when the repository has a remote and host sign-in, and fast-forwards locally otherwise."
          control={
            <Select
              value={form.landing}
              onValueChange={(value) => {
                if (value === "auto" || value === "pullRequest" || value === "local") {
                  change("landing", value);
                }
              }}
            >
              <SelectTrigger aria-label="Landing" className="w-auto min-w-40">
                <SelectValue>
                  {(value: LandingChoice | null) => LANDING_LABEL[value ?? "auto"]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(Object.keys(LANDING_LABEL) as LandingChoice[]).map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {LANDING_LABEL[choice]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Fix rounds"
          description="How often a card goes back to its agent on its own for failing CI, and for review feedback, before it waits for you."
          control={
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              CI
              <Input
                size="sm"
                className="w-16"
                aria-label="CI fix rounds"
                inputMode="numeric"
                value={form.ciFixRounds}
                onChange={(event) => change("ciFixRounds", event.target.value)}
              />
              Review
              <Input
                size="sm"
                className="w-16"
                aria-label="Review fix rounds"
                inputMode="numeric"
                value={form.reviewFixRounds}
                onChange={(event) => change("reviewFixRounds", event.target.value)}
              />
            </div>
          }
        />
        <SettingsRow
          title="Review without checks"
          description={
            form.checksWaived
              ? "Warning: cards enter review with nothing run against their work. Add check scripts instead when you can."
              : "Without check scripts, cards can't enter review. Waive only for projects with nothing to run."
          }
          control={
            <Switch
              aria-label="Review without checks"
              checked={form.checksWaived}
              onCheckedChange={(checked) => change("checksWaived", checked)}
            />
          }
        />
        <SettingsRow
          title="Network for agent shells"
          description="None blocks every domain. An allowlist permits only the domains listed; denied domains are never reachable. With network on, credential helpers on this machine are reachable too."
          control={
            <Select
              value={form.egressMode}
              onValueChange={(value) => {
                if (value === "none" || value === "allowlist") change("egressMode", value);
              }}
            >
              <SelectTrigger aria-label="Network for agent shells" className="w-auto min-w-32">
                <SelectValue>
                  {(value: string | null) => (value === "allowlist" ? "Allowlist" : "None")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="allowlist">Allowlist</SelectItem>
              </SelectPopup>
            </Select>
          }
        >
          <div className="grid gap-3 px-4 pb-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Allowed domains, one per line
              <Textarea
                aria-label="Allowed domains"
                disabled={form.egressMode === "none"}
                value={form.allow}
                onChange={(event) => change("allow", event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Denied domains, one per line
              <Textarea
                aria-label="Denied domains"
                value={form.deny}
                onChange={(event) => change("deny", event.target.value)}
              />
              <Button
                size="sm"
                variant="ghost-muted"
                className="self-start"
                onClick={() =>
                  change(
                    "deny",
                    [...new Set([...lines(form.deny), ...PUBLISHING_DENY_TEMPLATE])].join("\n"),
                  )
                }
              >
                Deny publishing and billing APIs
              </Button>
            </label>
          </div>
        </SettingsRow>
        <SettingsRow
          title="Exclusive paths"
          description="One card at a time lands changes to these globs; the others rebase and run the command after it. One per line, as glob => command."
        >
          <div className="px-4 pb-3">
            <Textarea
              aria-label="Exclusive paths"
              className="font-mono"
              placeholder="packages/core/db/migrations/** => pnpm db:generate"
              value={form.exclusivePaths}
              onChange={(event) => change("exclusivePaths", event.target.value)}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="Heavy commands"
          description="Commands agents may run only through run_checks, so full suites queue for machine capacity. One pattern per line."
        >
          <div className="px-4 pb-3">
            <Textarea
              aria-label="Heavy commands"
              className="font-mono"
              placeholder="Bash(pnpm test:*)"
              value={form.heavyCommands}
              onChange={(event) => change("heavyCommands", event.target.value)}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="Sub-cards per card"
          description="How many open sub-cards an agent may propose for its own card."
          control={
            <Input
              size="sm"
              className="w-24"
              aria-label="Sub-cards per card"
              inputMode="numeric"
              value={form.builderSubCardsMax}
              onChange={(event) => change("builderSubCardsMax", event.target.value)}
            />
          }
        />
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Button
            size="sm"
            disabled={!edited || saving || !("policy" in parsed)}
            onClick={() => {
              if ("policy" in parsed) void save(parsed.policy);
            }}
          >
            Save policy
          </Button>
          {"error" in parsed ? (
            <span className="text-xs text-destructive-foreground">{parsed.error}</span>
          ) : null}
        </div>
      </SettingsSection>
      <SideEffectGuard current={current} saving={saving} onSave={save} />
      <ProjectSecrets project={props.representative} />
    </>
  );
}

/**
 * The checklist a person works through before agents may start on this project: scheduled jobs
 * and outbound APIs that could act on real accounts, and a kill switch that code actually reads.
 */
function SideEffectGuard(props: {
  readonly current: ProjectOrchestration;
  readonly saving: boolean;
  readonly onSave: (policy: ProjectOrchestration) => Promise<void>;
}) {
  const guard = props.current.sideEffectGuard;
  const [scheduledJobs, setScheduledJobs] = useState(false);
  const [outboundApis, setOutboundApis] = useState(false);
  const [verified, setVerified] = useState(false);
  const [killSwitchEnv, setKillSwitchEnv] = useState(guard.killSwitchEnv ?? "");
  const ready = scheduledJobs && outboundApis && (killSwitchEnv.trim().length === 0 || verified);
  const withGuard = (sideEffectGuard: ProjectOrchestration["sideEffectGuard"]) =>
    void props.onSave({ ...props.current, sideEffectGuard });

  return (
    <SettingsSection id="project-side-effect-guard" title="Side-effect guard">
      <SettingsRow
        title={guard.acknowledgedAt === null ? "Not reviewed" : "Reviewed"}
        description={
          guard.acknowledgedAt === null
            ? "Agents don't start work on this project until someone goes through this list."
            : `Reviewed ${new Date(guard.acknowledgedAt).toLocaleString()}${guard.killSwitchEnv === null ? "" : `; cards run with ${guard.killSwitchEnv} set to stop outbound actions`}.`
        }
        control={
          guard.acknowledgedAt === null ? null : (
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={props.saving}
              onClick={() =>
                withGuard({ acknowledgedAt: null, killSwitchEnv: guard.killSwitchEnv })
              }
            >
              Review again
            </Button>
          )
        }
      />
      {guard.acknowledgedAt === null ? (
        <div className="flex flex-col gap-2.5 px-4 py-3 text-sm">
          <label className="flex items-start gap-2">
            <Checkbox
              className="mt-0.5"
              checked={scheduledJobs}
              onCheckedChange={(checked) => setScheduledJobs(checked === true)}
            />
            I checked this project's scheduled jobs and workers (crons, queues) for anything that
            posts, sends or charges on its own.
          </label>
          <label className="flex items-start gap-2">
            <Checkbox
              className="mt-0.5"
              checked={outboundApis}
              onCheckedChange={(checked) => setOutboundApis(checked === true)}
            />
            I checked which outbound APIs it calls (publishing, email, payments) and denied the ones
            agents must not reach under Network.
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              Kill-switch environment variable (optional), such as PUBLISHING_ENABLED
            </span>
            <Input
              size="sm"
              className="w-full sm:w-64"
              aria-label="Kill-switch environment variable"
              value={killSwitchEnv}
              onChange={(event) => setKillSwitchEnv(event.target.value)}
            />
          </div>
          {killSwitchEnv.trim().length > 0 ? (
            <label className="flex items-start gap-2">
              <Checkbox
                className="mt-0.5"
                checked={verified}
                onCheckedChange={(checked) => setVerified(checked === true)}
              />
              I verified that code reads {killSwitchEnv.trim()}. A documented switch that no code
              reads stops nothing.
            </label>
          ) : null}
          <Button
            size="sm"
            className="self-start"
            disabled={!ready || props.saving}
            onClick={() =>
              withGuard({
                acknowledgedAt: new Date().toISOString(),
                killSwitchEnv: killSwitchEnv.trim().length === 0 ? null : killSwitchEnv.trim(),
              })
            }
          >
            Acknowledge
          </Button>
        </div>
      ) : null}
    </SettingsSection>
  );
}

interface SecretRow {
  readonly name: string;
  readonly exposure: "setup" | "workspace";
}

/**
 * The names of secrets this project's card scripts receive, and where each may go: setup-only
 * secrets reach just the setup process; workspace secrets may be written into the card's worktree.
 * Values live in this machine's secret store, not here.
 */
function ProjectSecrets(props: { readonly project: Project }) {
  const { environments } = useEnvironments();
  const updateSettings = useUpdateEnvironmentSettings(props.project.environmentId);
  const cardRuntime = environments.find(
    (environment) => environment.environmentId === props.project.environmentId,
  )?.serverConfig?.settings.cardRuntime;
  const saved: ReadonlyArray<SecretRow> = cardRuntime?.secrets[props.project.id] ?? [];
  // Each row keeps a local key while edited; saved rows are only names and exposures.
  const [rows, setRows] = useState(() => saved.map((row) => ({ ...row, key: randomUUID() })));
  const cleaned: ReadonlyArray<SecretRow> = rows.flatMap((row) =>
    row.name.trim().length === 0 ? [] : [{ name: row.name.trim(), exposure: row.exposure }],
  );
  if (cardRuntime === undefined) return null;
  return (
    <SettingsSection id="project-card-secrets" title="Card secrets">
      <SettingsRow
        title="Secret names"
        description="Setup-only secrets reach just the setup script. Workspace secrets may be written into the card's worktree, which its agent can read."
      >
        <div className="flex flex-col gap-1.5 px-4 pb-3">
          {rows.map((row, index) => (
            <div key={row.key} className="flex items-center gap-1.5">
              <Input
                size="sm"
                className="min-w-0 flex-1 font-mono"
                aria-label="Secret name"
                value={row.name}
                onChange={(event) =>
                  setRows(
                    rows.map((entry, at) =>
                      at === index ? { ...entry, name: event.target.value } : entry,
                    ),
                  )
                }
              />
              <Select
                value={row.exposure}
                onValueChange={(value) => {
                  if (value === "setup" || value === "workspace") {
                    setRows(
                      rows.map((entry, at) =>
                        at === index ? { ...entry, exposure: value } : entry,
                      ),
                    );
                  }
                }}
              >
                <SelectTrigger aria-label="Exposure" className="w-auto min-w-32">
                  <SelectValue>
                    {(value: string | null) => (value === "workspace" ? "Workspace" : "Setup only")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="setup">Setup only</SelectItem>
                  <SelectItem value="workspace">Workspace</SelectItem>
                </SelectPopup>
              </Select>
              <Button
                size="sm"
                variant="ghost-muted"
                onClick={() => setRows(rows.filter((_, at) => at !== index))}
              >
                Remove
              </Button>
            </div>
          ))}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost-muted"
              onClick={() => setRows([...rows, { key: randomUUID(), name: "", exposure: "setup" }])}
            >
              Add secret
            </Button>
            <Button
              size="sm"
              disabled={JSON.stringify(cleaned) === JSON.stringify(saved)}
              onClick={() =>
                updateSettings({
                  cardRuntime: {
                    ...cardRuntime,
                    secrets: { ...cardRuntime.secrets, [props.project.id]: cleaned },
                  },
                })
              }
            >
              Save secrets
            </Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

interface RuntimeForm {
  readonly heavyJobConcurrency: string;
  readonly environmentSessionCap: string;
  readonly load: string;
  readonly freeMem: string;
  readonly turboConcurrency: string;
  readonly vitestMaxWorkers: string;
  readonly nodeMaxOldSpaceMb: string;
}

const optionalNumber = (value: number | null) => (value === null ? "" : String(value));

/**
 * How this machine runs card work, whatever the project: heavy jobs at once, sessions at once,
 * when admission holds a heavy job back, and the resource limits given to agent shells and scripts.
 * Blank fields are derived from the machine's cores and memory.
 */
export function CardRuntimeSettings(props: { readonly environmentId: EnvironmentId | null }) {
  const { environments } = useEnvironments();
  const current = environments.find(
    (environment) => environment.environmentId === props.environmentId,
  )?.serverConfig?.settings.cardRuntime;
  if (props.environmentId === null || current === undefined) return null;
  return (
    <CardRuntimeForm
      key={JSON.stringify(current)}
      environmentId={props.environmentId}
      current={current}
    />
  );
}

function CardRuntimeForm(props: {
  readonly environmentId: EnvironmentId;
  readonly current: CardRuntimeSettingsValue;
}) {
  const { current } = props;
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const [form, setForm] = useState<RuntimeForm>(() => ({
    heavyJobConcurrency: String(current.heavyJobConcurrency),
    environmentSessionCap: optionalNumber(current.environmentSessionCap),
    load: String(current.admission.load),
    freeMem: String(current.admission.freeMem),
    turboConcurrency: optionalNumber(current.resourceProfile.turboConcurrency),
    vitestMaxWorkers: optionalNumber(current.resourceProfile.vitestMaxWorkers),
    nodeMaxOldSpaceMb: optionalNumber(current.resourceProfile.nodeMaxOldSpaceMb),
  }));
  const field = (key: keyof RuntimeForm, label: string, placeholder?: string) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        size="sm"
        inputMode="decimal"
        aria-label={label}
        placeholder={placeholder}
        value={form[key]}
        onChange={(event) => setForm((previous) => ({ ...previous, [key]: event.target.value }))}
      />
    </label>
  );
  const heavy = wholeNumber(form.heavyJobConcurrency, 1, undefined);
  const sessions = wholeNumber(form.environmentSessionCap, 1, null);
  const turbo = wholeNumber(form.turboConcurrency, 1, null);
  const vitest = wholeNumber(form.vitestMaxWorkers, 1, null);
  const heap = wholeNumber(form.nodeMaxOldSpaceMb, 1, null);
  const load = Number(form.load);
  const freeMem = Number(form.freeMem);
  const blankOr = (text: string, value: number | null) =>
    text.trim().length === 0 || value !== null;
  const valid =
    typeof heavy === "number" &&
    blankOr(form.environmentSessionCap, sessions) &&
    blankOr(form.turboConcurrency, turbo) &&
    blankOr(form.vitestMaxWorkers, vitest) &&
    blankOr(form.nodeMaxOldSpaceMb, heap) &&
    Number.isFinite(load) &&
    load > 0 &&
    Number.isFinite(freeMem) &&
    freeMem >= 0 &&
    freeMem < 1;
  const next: CardRuntimeSettingsValue | null =
    valid && typeof heavy === "number"
      ? {
          ...current,
          heavyJobConcurrency: heavy,
          environmentSessionCap: sessions ?? null,
          admission: { load, freeMem },
          resourceProfile: {
            turboConcurrency: turbo ?? null,
            vitestMaxWorkers: vitest ?? null,
            nodeMaxOldSpaceMb: heap ?? null,
          },
        }
      : null;

  return (
    <FoldedSettingsSection
      id="card-runtime"
      title="Card runtime"
      summary={`${current.heavyJobConcurrency} heavy job${current.heavyJobConcurrency === 1 ? "" : "s"} at once`}
    >
      <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
        {field("heavyJobConcurrency", "Heavy jobs at once (checks, setup, evidence)")}
        {field("environmentSessionCap", "Agent sessions at once", "Derived")}
        {field("load", "Hold heavy jobs above load per core")}
        {field("freeMem", "Hold heavy jobs below free memory (0–1)")}
        {field("turboConcurrency", "Turbo concurrency", "Derived")}
        {field("vitestMaxWorkers", "Vitest workers", "Derived")}
        {field("nodeMaxOldSpaceMb", "Node heap (MB)", "Derived")}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Button
          size="sm"
          disabled={next === null || JSON.stringify(next) === JSON.stringify(current)}
          onClick={() => {
            if (next !== null) updateSettings({ cardRuntime: next });
          }}
        >
          Save
        </Button>
        {!valid ? (
          <span className="text-xs text-destructive-foreground">
            Use whole numbers of at least 1, a load above 0 and free memory between 0 and 1.
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            macOS reports less free memory than is reclaimable; lower the threshold if heavy jobs
            wait too often.
          </span>
        )}
      </div>
    </FoldedSettingsSection>
  );
}
