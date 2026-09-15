import type { CriterionMark, PillTone, SparkState } from "@iskra/client-runtime/card-face";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";

// The identity's meaning colors, as the system colors iOS uses in both appearances.
export const TONE_COLOR: Record<PillTone, string> = {
  gray: "#8E8E93",
  blue: "#0A84FF",
  orange: "#FF9F0A",
  green: "#30D158",
  red: "#FF453A",
};

const SPARK_COLOR: Record<SparkState, string> = {
  idle: TONE_COLOR.gray,
  working: TONE_COLOR.blue,
  needsYou: TONE_COLOR.orange,
  landed: TONE_COLOR.green,
};

const SPARK = "M12 2.5l2.1 7.4 7.4 2.1-7.4 2.1-2.1 7.4-2.1-7.4-7.4-2.1 7.4-2.1z";
const SPARK_INSET = "M12 5l1.5 5.5 5.5 1.5-5.5 1.5-1.5 5.5-1.5-5.5-5.5-1.5 5.5-1.5z";

const SPARK_LABEL: Record<SparkState, string> = {
  idle: "Idle",
  working: "Working",
  needsYou: "Needs you",
  landed: "Landed",
};

/** Iskra's spark: an outline at rest, filled blue working, orange for a person, green disc landed. */
export function SparkGlyph(props: { readonly state: SparkState; readonly size?: number }) {
  const color = SPARK_COLOR[props.state];
  const size = props.size ?? 16;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityLabel={SPARK_LABEL[props.state]}>
      {props.state === "landed" ? (
        <>
          <Circle cx={12} cy={12} r={11} fill={color} fillOpacity={0.18} />
          <Path d={SPARK_INSET} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />
        </>
      ) : (
        <Path
          d={SPARK}
          fill={props.state === "idle" ? "none" : color}
          stroke={color}
          strokeWidth={props.state === "idle" ? 1.3 : 1.2}
          strokeLinejoin="round"
        />
      )}
    </Svg>
  );
}

/** A capsule naming a status, colored by what it means. */
export function StatusPill(props: { readonly label: string; readonly tone: PillTone }) {
  const color = TONE_COLOR[props.tone];
  return (
    <View
      style={{ backgroundColor: `${color}26`, borderRadius: 999, paddingHorizontal: 8, height: 20 }}
      className="shrink-0 justify-center"
    >
      <Text style={{ color, fontSize: 11, fontWeight: "600" }} numberOfLines={1}>
        {props.label}
      </Text>
    </View>
  );
}

// Identity hues only: none reuses the colors that mean work, a person, verified or failed.
const AVATAR_GRADIENTS = [
  ["#8e8cff", "#5e5ce6"],
  ["#70d7e0", "#30b0c7"],
  ["#da8fff", "#bf5af2"],
] as const;

/** An agent as a round gradient initial, the same hue everywhere, with its spark as a badge. */
export function AgentAvatar(props: {
  readonly name: string;
  readonly spark?: SparkState | undefined;
  readonly size?: number;
}) {
  const size = props.size ?? 28;
  let hash = 0;
  for (const character of props.name) hash += character.charCodeAt(0);
  const [from, to] = AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length]!;
  const gradientId = `avatar-${hash % AVATAR_GRADIENTS.length}`;
  return (
    <View
      accessibilityLabel={`@${props.name}`}
      style={{ width: size, height: size }}
      className="items-center justify-center"
    >
      <Svg width={size} height={size} style={{ position: "absolute" }}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={from} />
            <Stop offset="1" stopColor={to} />
          </LinearGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${gradientId})`} />
      </Svg>
      <Text style={{ color: "#fff", fontSize: size * 0.42, fontWeight: "600" }}>
        {props.name.charAt(0).toUpperCase()}
      </Text>
      {props.spark !== undefined ? (
        <View
          style={{ position: "absolute", right: -4, bottom: -3, borderRadius: 999, padding: 1 }}
          className="bg-card"
        >
          <SparkGlyph state={props.spark} size={Math.max(10, size * 0.42)} />
        </View>
      ) : null}
    </View>
  );
}

const MARK_COLOR: Record<CriterionMark, string> = {
  passed: TONE_COLOR.green,
  failed: TONE_COLOR.red,
  needsYou: TONE_COLOR.orange,
  pending: `${TONE_COLOR.gray}55`,
};

/** One short segment per acceptance criterion, in the card's criterion order. */
export function CriteriaMarks(props: { readonly marks: ReadonlyArray<CriterionMark> }) {
  if (props.marks.length === 0) return null;
  const passed = props.marks.filter((mark) => mark === "passed").length;
  return (
    <View
      accessibilityLabel={`${passed} of ${props.marks.length} criteria passed`}
      className="flex-row gap-[3px]"
    >
      {props.marks.map((mark, index) => (
        // oxlint-disable-next-line react/no-array-index-key
        <View key={index} style={{ width: 12, height: 4, borderRadius: 2, backgroundColor: MARK_COLOR[mark] }} />
      ))}
    </View>
  );
}

/** Spend against the cap as a thin bar; red once the cap is reached. */
export function SpendBar(props: { readonly spentUsd: number; readonly capUsd: number }) {
  const ratio = props.capUsd <= 0 ? 1 : Math.min(1, props.spentUsd / props.capUsd);
  return (
    <View
      accessibilityLabel={`$${props.spentUsd.toFixed(2)} of $${props.capUsd.toFixed(0)} spent`}
      style={{ width: 44, height: 4, borderRadius: 2, backgroundColor: `${TONE_COLOR.gray}40`, overflow: "hidden" }}
    >
      <View
        style={{
          width: `${Math.round(ratio * 100)}%`,
          height: 4,
          backgroundColor: ratio >= 1 ? TONE_COLOR.red : TONE_COLOR.blue,
        }}
      />
    </View>
  );
}

/** Fix rounds used of the cap: filled orange dots for used rounds, rings for the rest. */
export function RoundDots(props: { readonly used: number; readonly cap: number; readonly label: string }) {
  if (props.cap <= 0) return null;
  const used = Math.min(props.used, props.cap);
  return (
    <View accessibilityLabel={`${props.label}: ${used} of ${props.cap} used`} className="flex-row gap-1">
      {Array.from({ length: props.cap }, (_, index) => (
        <View
          key={index}
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            ...(index < used
              ? { backgroundColor: TONE_COLOR.orange }
              : { borderWidth: 1.5, borderColor: `${TONE_COLOR.gray}66` }),
          }}
        />
      ))}
    </View>
  );
}

/** A centered line for something that happened, such as Iskra's note that a card started. */
export function EventLine(props: { readonly spark?: SparkState; readonly children: ReactNode }) {
  return (
    <View className="flex-row flex-wrap items-center justify-center gap-1.5 py-1">
      <SparkGlyph state={props.spark ?? "idle"} size={12} />
      {props.children}
    </View>
  );
}

/** A grouped inset list: a titled rounded surface whose rows are split by hairlines. */
export function Group(props: {
  readonly title?: string;
  readonly footer?: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-1.5">
      {props.title ? (
        <Text className="px-4 text-[13px] text-foreground-muted uppercase">{props.title}</Text>
      ) : null}
      <View className="overflow-hidden rounded-xl border-continuous bg-card">{props.children}</View>
      {props.footer ? (
        <Text className="px-4 text-[13px] text-foreground-muted">{props.footer}</Text>
      ) : null}
    </View>
  );
}

/** One row of a group; `first` drops the hairline above it. */
export function Row(props: {
  readonly first?: boolean;
  readonly onPress?: () => void;
  readonly children: ReactNode;
}) {
  const content = (
    <View
      className={
        props.first ? "min-h-11 gap-1.5 px-4 py-2.5" : "min-h-11 gap-1.5 border-t border-border px-4 py-2.5"
      }
    >
      {props.children}
    </View>
  );
  return props.onPress === undefined ? (
    content
  ) : (
    <Pressable accessibilityRole="button" onPress={props.onPress} className="active:opacity-60">
      {content}
    </Pressable>
  );
}

export function Muted(props: { readonly children: ReactNode; readonly lines?: number }) {
  return (
    <Text className="text-[13px] text-foreground-muted" numberOfLines={props.lines}>
      {props.children}
    </Text>
  );
}

export function Body(props: { readonly children: ReactNode; readonly lines?: number; readonly strong?: boolean }) {
  return (
    <Text
      className="text-[15px] text-foreground"
      style={props.strong ? { fontWeight: "600" } : undefined}
      numberOfLines={props.lines}
      selectable
    >
      {props.children}
    </Text>
  );
}

/** A capsule button: filled blue for the one recommended action, tinted otherwise. */
export function ActionButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly kind?: "primary" | "plain" | "destructive";
  readonly disabled?: boolean;
}) {
  const kind = props.kind ?? "plain";
  const color = kind === "destructive" ? TONE_COLOR.red : TONE_COLOR.blue;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        backgroundColor: kind === "primary" ? color : `${color}1F`,
        borderRadius: 999,
        paddingHorizontal: 14,
        minHeight: 34,
        justifyContent: "center",
        opacity: props.disabled ? 0.4 : 1,
      }}
      className="active:opacity-60"
    >
      <Text style={{ color: kind === "primary" ? "#fff" : color, fontSize: 15, fontWeight: "600" }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function ButtonRow(props: { readonly children: ReactNode }) {
  return <View className="flex-row flex-wrap items-center gap-2">{props.children}</View>;
}

/** A segmented control: one selected segment, each with an optional count. */
export function Segmented<T extends string>(props: {
  readonly segments: ReadonlyArray<{ readonly value: T; readonly label: string; readonly count?: number }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-1 rounded-[10px] bg-subtle p-0.5">
      {props.segments.map((segment) => {
        const selected = segment.value === props.value;
        return (
          <Pressable
            key={segment.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => props.onChange(segment.value)}
            className={selected ? "rounded-lg bg-card px-3 py-1.5" : "rounded-lg px-3 py-1.5"}
          >
            <Text
              className={selected ? "text-[13px] text-foreground" : "text-[13px] text-foreground-muted"}
              style={{ fontWeight: selected ? "600" : "400" }}
            >
              {segment.label}
              {segment.count !== undefined && segment.count > 0 ? ` ${segment.count}` : ""}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
