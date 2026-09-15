import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  scrollToSettingsTarget,
  SettingsRow,
  SettingsSearchTargetProvider,
  SettingsUnavailableGroup,
  splitSettingDescription,
} from "./settingsLayout";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unavailable settings", () => {
  it("groups disabled controls under one reason", () => {
    const markup = renderToStaticMarkup(
      <SettingsUnavailableGroup message="Only available in the desktop app.">
        <SettingsRow title="Window capture" description="Capture a window." />
      </SettingsUnavailableGroup>,
    );

    expect(markup).toContain("Only available in the desktop app.");
    expect(markup).toContain("data-settings-unavailable");
  });
});

describe("setting captions", () => {
  it("keeps a short caption inline", () => {
    expect(splitSettingDescription("Wrap long lines.")).toEqual({
      inline: "Wrap long lines.",
      full: null,
    });
  });

  it("keeps the first sentence inline and the whole explanation behind the info button", () => {
    const text =
      "Settle a conversation when its pull request merges. Closed pull requests still settle automatically.";
    expect(splitSettingDescription(text)).toEqual({
      inline: "Settle a conversation when its pull request merges.",
      full: text,
    });
  });

  it("moves a long single sentence behind the info button instead of cutting it", () => {
    const text =
      "Pairing links and client-session management require the access:write scope for this backend";
    expect(splitSettingDescription(text)).toEqual({ inline: null, full: text });
  });

  it("renders rich captions as given", () => {
    const rich = <span>Archived today</span>;
    expect(splitSettingDescription(rich)).toEqual({ inline: rich, full: null });
  });
});

describe("settings search targets", () => {
  it("does not persist destination styling in the rendered row", () => {
    const markup = renderToStaticMarkup(
      <SettingsSearchTargetProvider targetId="word-wrap">
        <SettingsRow id="word-wrap" title="Word wrap" description="Wrap long lines." />
        <SettingsRow id="time-format" title="Time format" description="Choose a clock." />
      </SettingsSearchTargetProvider>,
    );

    expect(markup).toContain('id="word-wrap" tabindex="-1"');
    expect(markup).not.toContain("data-settings-search-target");
    expect(markup).not.toContain("settings-search-target-pulse");
  });

  it("scrolls directly to a section header and restarts the destination pulse", () => {
    const sectionScrollIntoView = vi.fn();
    const headerScrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const addEventListener = vi.fn();
    const target = {
      tagName: "SECTION",
      firstElementChild: { scrollIntoView: headerScrollIntoView },
      scrollIntoView: sectionScrollIntoView,
      focus,
      classList: { remove, add },
      addEventListener,
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
    });

    expect(scrollToSettingsTarget("providers")).toBe(true);
    expect(headerScrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(sectionScrollIntoView).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(addEventListener).toHaveBeenCalledWith("blur", expect.any(Function), { once: true });
  });

  it("does not animate the destination when reduced motion is requested", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const target = {
      tagName: "DIV",
      firstElementChild: null,
      scrollIntoView,
      focus,
      classList: { remove, add },
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: true })),
    });

    expect(scrollToSettingsTarget("word-wrap")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).not.toHaveBeenCalled();
  });

  it("leaves not-yet-mounted destinations to their mount lifecycle", () => {
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => null),
    });

    expect(scrollToSettingsTarget("archive")).toBe(false);
  });
});
