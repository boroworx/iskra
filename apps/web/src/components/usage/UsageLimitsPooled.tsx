import {
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  formatDuration,
  formatResetsIn,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  remainingPercent,
} from "@iskra/shared/usageLimits";
import { AlertTriangleIcon, TicketIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { SETTINGS_SECTION_HEAD_CLASSNAME } from "../settings/settingsLayout";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { Alert, AlertTitle } from "../ui/alert";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { PaceIcon, ResetCreditDialog, resetCreditsSummary, useResetCredit } from "./UsageLimits";

/** `someone@example.com` → `SE`: enough to tell accounts apart, too little to identify one. */
function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

/** A stable hue per email, so the same account gets the same chip on every visit. */
function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** The two-letter chip for an email, coloured by a stable hue per address. */
function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  return (
    <span
      role="img"
      aria-label={`Account ${accountInitials(email)}`}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] leading-none font-semibold"
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}

/**
 * The same mark the model picker uses for a native instance (provider glyph,
 * initials badge, accent); hub accounts have no instance, so they get the chip.
 */
function AccountAvatar({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.redeem) {
    return (
      <ProviderInstanceIcon
        driverKind={account.driver}
        displayName={
          account.displayName ?? getDriverOption(account.driver)?.label ?? String(account.driver)
        }
        accentColor={account.accentColor}
        showBadge={Boolean(account.displayName)}
        indicatorBackground="var(--popover)"
        className={cn("size-5", className)}
        iconClassName="size-4 text-foreground/80"
      />
    );
  }
  return account.email ? <AccountChip email={account.email} /> : null;
}

/**
 * Who an account is, without printing the email: the instance name when there
 * is one, else a two-letter chip. The address itself is revealed on demand in
 * the segment's popover.
 */
function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.displayName) return <span className={className}>{account.displayName}</span>;
  if (account.email) {
    return (
      <span className={cn("inline-flex min-w-0 items-center", className)}>
        <AccountChip email={account.email} />
      </span>
    );
  }
  return (
    <span className={className}>
      {getDriverOption(account.driver)?.label ?? String(account.driver)}
    </span>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

/**
 * Everything about one account in one window: plan, where it is signed in,
 * the email on request, reset time and share of the pool it restores, and the
 * reset-credit action. Opens on hover for a glance, on click to act.
 */
function SegmentPopover({
  account,
  window,
  reset,
  now,
  redeem,
  onRedeem,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  /** Redeem state owned by the segment, since the confirm lives outside this popover. */
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly onRedeem: () => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now);
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel;
  const credits =
    redeem && account.limits.resetCredits?.availableCount ? account.limits.resetCredits : null;
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">
            {account.displayName ?? getDriverOption(account.driver)?.label ?? account.driver}
          </span>
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="w-fit"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.plan ? <Row label="Plan">{account.plan}</Row> : null}
        {where ? (
          <Row label={account.environments.length > 0 ? "Signed in" : "Via"}>{where}</Row>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label="Left">{remaining}%</Row>
        {window.resetsAt ? (
          <Row label="Resets">
            {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            {resetsIn ? ` · ${resetsIn.replace("resets in ", "in ")}` : ""}
          </Row>
        ) : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label="Restores">+{reset.restoresPercent}% of pool</Row>
        ) : null}
      </div>
      {credits && redeem ? (
        <div className="border-t border-border/60 pt-2.5 text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="tabular-nums">{resetCreditsSummary(credits, now, true)}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={redeem.busy}
              className="ms-auto"
              onClick={onRedeem}
            >
              {redeem.busy ? "Using…" : "Use reset"}
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One account's share of one pooled window: its caption (who, how much is
 * left, when it resets, banked credits) over a flat capsule track, the popover
 * and the reset confirm. The confirm is a sibling of the popover, not a child:
 * dialogs stack under popovers, and the popover closes as the confirm opens.
 */
function PoolSegment({
  account,
  window,
  reset,
  now,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
}) {
  const [open, setOpen] = useState(false);
  const remaining = remainingPercent(window);
  const exhausted = remaining <= 0;
  const resetsIn = formatResetsIn(window, now);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        render={
          <button
            type="button"
            aria-label={`${account.displayName ?? (account.email ? accountInitials(account.email) : account.driver)}: ${remaining}% left${resetsIn ? `, ${resetsIn}` : ""}${credits ? `, ${credits} reset ${credits === 1 ? "credit" : "credits"} banked` : ""}`}
            className="flex min-h-7 min-w-0 cursor-pointer flex-col gap-1.5 rounded-md py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          />
        }
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <AccountName account={account} className="min-w-0 truncate font-medium text-foreground" />
          <span
            className={cn(
              "shrink-0 tabular-nums",
              exhausted ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {remaining}%
          </span>
          <span
            aria-hidden
            className="ms-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums"
          >
            {resetsIn?.replace("resets in ", "↻ ") ?? ""}
            {credits ? (
              <>
                {resetsIn ? <span>·</span> : null}
                <span className="inline-flex items-center gap-0.5">
                  <TicketIcon className="size-3" aria-hidden />
                  {credits}
                </span>
              </>
            ) : null}
          </span>
        </span>
        {/* Blue is quota still open; a spent account's track turns red. */}
        <span
          aria-hidden
          className={cn(
            "relative h-1.5 w-full overflow-hidden rounded-full",
            exhausted ? "bg-destructive/30" : "bg-foreground/10",
          )}
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            style={{ width: `${remaining}%` }}
          />
        </span>
      </PopoverTrigger>
      {account.redeem ? (
        <RedeemableSegmentPopup
          account={account}
          window={window}
          reset={reset}
          now={now}
          redeemAt={account.redeem}
          closePopover={() => setOpen(false)}
        />
      ) : (
        <PopoverPopup side="top" sideOffset={6}>
          <SegmentPopover
            account={account}
            window={window}
            reset={reset}
            now={now}
            redeem={null}
            onRedeem={() => {}}
          />
        </PopoverPopup>
      )}
    </Popover>
  );
}

/** Split out so the redeem hook only runs for accounts that can redeem. */
function RedeemableSegmentPopup({
  account,
  window,
  reset,
  now,
  redeemAt,
  closePopover,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
  readonly closePopover: () => void;
}) {
  const redeem = useResetCredit(redeemAt.environmentId, redeemAt.input);
  return (
    <>
      <PopoverPopup side="top" sideOffset={6}>
        <SegmentPopover
          account={account}
          window={window}
          reset={reset}
          now={now}
          redeem={redeem}
          onRedeem={() => {
            closePopover();
            redeem.setConfirming(true);
          }}
        />
      </PopoverPopup>
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
      />
      {/* The popover closed before the confirm, so the outcome needs a home outside it. */}
      {redeem.status ? (
        <span role="status" className="col-span-full text-xs text-muted-foreground">
          <AccountName account={account} className="font-medium text-foreground" /> {redeem.status}
        </span>
      ) : null}
    </>
  );
}

/**
 * One pooled window as equal-width segments, one per account, each filled by
 * the share of that account's quota still open. Equal widths are honest: every
 * account contributes the same share of the pool, whatever its plan. Narrow,
 * the segments stack so every caption keeps its room.
 */
function PoolBar({ pool, now }: { readonly pool: LimitPoolWindow; readonly now: number }) {
  const restores = new Map(pool.resets.map((reset) => [reset.member.account.key, reset]));
  return (
    <div className="@container/pool min-w-0">
      <div
        className="grid gap-x-4 gap-y-2 @2xl/pool:grid-cols-(--pool-columns)"
        style={
          {
            "--pool-columns": `repeat(${pool.columns.length}, minmax(0, 1fr))`,
          } as CSSProperties
        }
      >
        {pool.columns.map((member) =>
          member.window ? (
            <PoolSegment
              key={member.account.key}
              account={member.account}
              window={member.window}
              reset={restores.get(member.account.key)}
              now={now}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

/**
 * Big pooled number and the segment bar. Accounts keep the same column across
 * windows; each segment's popover shows its own reset time and share restored.
 */
function PoolWindowCard({ pool, now }: { readonly pool: LimitPoolWindow; readonly now: number }) {
  // The soonest reset that hands anything back; an untouched account resets to no effect.
  const nextRefill = pool.resets.find((reset) => reset.restoresPercent > 0);
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-xl bg-card p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] text-foreground">{pool.label}</span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-[22px] leading-tight font-bold text-foreground tabular-nums">
            {pool.remainingPercent}%
          </span>
          <span className="text-[13px] text-muted-foreground">left</span>
          {pool.pace ? <PaceIcon pace={pool.pace} /> : null}
        </span>
        {nextRefill ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            ↻ +{nextRefill.restoresPercent}%{" "}
            {nextRefill.at <= now ? "now" : `in ${formatDuration(nextRefill.at - now)}`}
          </span>
        ) : null}
      </div>
      <PoolBar pool={pool} now={now} />
    </div>
  );
}

function PoolSection({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);
  return (
    <section className="flex flex-col gap-2">
      <h2 className={cn(SETTINGS_SECTION_HEAD_CLASSNAME, "px-4")}>{label}</h2>
      {pool.windows.map((window) => (
        <PoolWindowCard key={`${window.kind}:${window.id}`} pool={window} now={now} />
      ))}
    </section>
  );
}

/**
 * Accounts pooled per provider: what is open across all of them, who resets
 * next, and how much of the pool that hands back. Answers "can I keep going"
 * before "on which account".
 */
export function UsageLimitsPooled({
  presentations,
  now,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
}) {
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations);
  return (
    <div className="flex flex-col gap-7">
      {pools.length === 0 && notices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      {pools.map((pool) => (
        <PoolSection key={pool.driver} pool={pool} now={now} />
      ))}
      <LimitNotices notices={notices} />
    </div>
  );
}

/** Sources and providers that could not be read, so a missing bar is not mistaken for a full one. */
function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
