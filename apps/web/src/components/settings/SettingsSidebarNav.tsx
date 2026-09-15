import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ActivityIcon,
  BlocksIcon,
  BotIcon,
  createLucideIcon,
  GitBranchIcon,
  PanelsTopLeftIcon,
  KeyboardIcon,
  Link2Icon,
  MessagesSquareIcon,
  PaletteIcon,
  ScrollTextIcon,
  SearchIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { SidebarUtilityMenu } from "../sidebar/SidebarChrome";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  searchSettings,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";

const SnapShotIcon = createLucideIcon("snap-shot", [
  [
    "path",
    {
      d: "M8 3H6a3 3 0 0 0-3 3v2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2",
      key: "capture-frame",
    },
  ],
  ["rect", { width: "10", height: "8", x: "7", y: "8", rx: "2", key: "window" }],
  ["circle", { cx: "12", cy: "12", r: "1.5", key: "lens" }],
]);

const IskraConnectSidebarSignIn = lazy(() =>
  import("../clerk/IskraConnectSidebarSignIn").then((module) => ({
    default: module.IskraConnectSidebarSignIn,
  })),
);
const IskraConnectSidebarAvatar = lazy(() =>
  import("../clerk/IskraConnectSidebarSignIn").then((module) => ({
    default: module.IskraConnectSidebarAvatar,
  })),
);

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/appearance": PaletteIcon,
  "/settings/projects": PanelsTopLeftIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/snap-shot": SnapShotIcon,
  "/settings/providers": BotIcon,
  "/settings/integrations": BlocksIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/connections": Link2Icon,
  "/settings/archived": MessagesSquareIcon,
  "/settings/diagnostics": ActivityIcon,
  "/settings/open-source-licenses": ScrollTextIcon,
};

/** Tile fills, System Settings style. Orange and red stay reserved for "needs you" and failures. */
const SETTINGS_SECTION_TILES: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "from-[#a1a1a6] to-[#6e6e73]",
  "/settings/appearance": "from-[#da8fff] to-[#af52de]",
  "/settings/projects": "from-[#409cff] to-[#0a6fe0]",
  "/settings/keybindings": "from-[#8e8e93] to-[#58585c]",
  "/settings/snap-shot": "from-[#70d7e0] to-[#30b0c7]",
  "/settings/providers": "from-[#8e8cff] to-[#5e5ce6]",
  "/settings/integrations": "from-[#64d2ff] to-[#0a9fd8]",
  "/settings/source-control": "from-[#4cd964] to-[#28a745]",
  "/settings/connections": "from-[#409cff] to-[#3a5bd9]",
  "/settings/archived": "from-[#b0a58f] to-[#8a7f6a]",
  "/settings/diagnostics": "from-[#8e8e93] to-[#58585c]",
  "/settings/open-source-licenses": "from-[#a1a1a6] to-[#6e6e73]",
};

/** A section's glyph on its colored rounded-square tile. */
function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-linear-to-b text-white shadow-[inset_0_0.5px_0_rgb(255_255_255/25%)]",
        SETTINGS_SECTION_TILES[to],
      )}
    >
      <Icon className="size-3 text-white" />
    </span>
  );
}

const SETTINGS_NAV_ROW_CLASSNAME =
  "h-7 gap-2 rounded-md px-1.5 text-[13px] font-normal text-sidebar-foreground data-[active=true]:bg-[rgb(0_0_0/8%)] data-[active=true]:font-normal dark:data-[active=true]:bg-white/10";

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const { isMobile, setOpenMobile, open, setOpen } = useSidebar();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const searchableItems = useAvailableSettingsSearchItems();
  const results = useMemo(() => searchSettings(query, searchableItems), [query, searchableItems]);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;

  useEffect(() => {
    setActiveResultIndex((index) => Math.min(index, Math.max(results.length - 1, 0)));
  }, [results.length]);

  useEffect(() => {
    const result = results[activeResultIndex];
    if (!result) return;
    document
      .getElementById(`settings-search-result-${result.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, results]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          // Keep focus inside open dialogs and popups instead of escaping
          // their focus trap into the sidebar search.
          target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null)
      ) {
        return;
      }

      event.preventDefault();
      if (isMobile) {
        setOpenMobile(true);
      } else if (!open) {
        setOpen(true);
      }
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, open, setOpen, setOpenMobile]);

  const handleSectionClick = useCallback(
    (to: SettingsPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to,
        hash: "",
        replace: true,
        hashScrollIntoView: false,
      });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);
  const handleSearchResultClick = useCallback(
    (item: SettingsSearchItem) => {
      clearSearch();
      if (isMobile) {
        setOpenMobile(false);
      }
      const targetId = item.targetId ?? item.id;
      if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
        scrollToSettingsTarget(targetId);
        return;
      }
      void navigate({
        to: item.to,
        hash: targetId,
        replace: true,
        hashScrollIntoView: false,
        state: { settingsTargetHighlight: true },
      });
    },
    [clearSearch, currentHash, isMobile, navigate, pathname, setOpenMobile],
  );
  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && isSearching) {
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        return;
      }
      if (results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveResultIndex((index) => (index + 1) % results.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveResultIndex((index) => (index - 1 + results.length) % results.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = results[activeResultIndex];
        if (result) handleSearchResultClick(result);
      }
    },
    [activeResultIndex, clearSearch, handleSearchResultClick, isSearching, results],
  );
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="gap-2 p-[var(--sidebar-content-inset)]">
          <div className="flex h-7 items-center gap-1.5 rounded-[7px] bg-[rgb(120_120_128/12%)] px-2 text-[13px] text-sidebar-muted-foreground focus-within:ring-2 focus-within:ring-ring dark:bg-[rgb(120_120_128/24%)]">
            <SearchIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
            <Input
              ref={searchInputRef}
              nativeInput
              unstyled
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveResultIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search"
              aria-label="Search settings"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={isSearching && hasResults}
              aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
              aria-activedescendant={
                isSearching && results[activeResultIndex]
                  ? `settings-search-result-${results[activeResultIndex].id}`
                  : undefined
              }
              className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-[13px] [&_[data-slot=input]]:font-normal [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground"
            />
            {isSearching ? (
              <Button
                type="button"
                size="icon-micro"
                variant="ghost"
                className="shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-control-surface hover:text-sidebar-foreground"
                aria-label="Clear settings search"
                onClick={() => {
                  clearSearch();
                  searchInputRef.current?.focus();
                }}
              >
                <XIcon className="size-3" />
              </Button>
            ) : (
              <Kbd className="h-4 min-w-0 rounded-sm bg-transparent px-1 text-[10px]">/</Kbd>
            )}
          </div>
          {isSearching && results.length === 0 ? (
            <p
              role="status"
              className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
            >
              No settings found
            </p>
          ) : null}
          {isSearching ? (
            <SidebarMenu
              className="ps-px"
              id={hasResults ? "settings-search-results" : undefined}
              role={hasResults ? "listbox" : undefined}
              aria-label={hasResults ? "Settings search results" : undefined}
            >
              {results.map((item, index) => (
                <SidebarMenuItem key={item.id} role="presentation">
                  <SidebarMenuButton
                    id={`settings-search-result-${item.id}`}
                    role="option"
                    aria-selected={index === activeResultIndex}
                    tabIndex={-1}
                    size="sm"
                    isActive={index === activeResultIndex}
                    className="h-auto min-h-9 items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-sidebar-row-hover hover:text-sidebar-foreground data-[active=true]:bg-[rgb(0_0_0/8%)] dark:data-[active=true]:bg-white/10"
                    onMouseMove={() => setActiveResultIndex(index)}
                    onClick={() => handleSearchResultClick(item)}
                  >
                    <SettingsSectionIcon to={item.to} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-sidebar-foreground">
                        {item.title}
                      </span>
                      <span className="block truncate text-[11px] text-sidebar-muted-foreground/75">
                        {SETTINGS_SECTION_LABELS[item.to]}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          ) : (
            <div className="flex flex-col gap-3">
              {SETTINGS_NAV_GROUPS.map((group) => (
                <div key={group.label} className="flex flex-col gap-0.5">
                  <p className="px-1.5 pb-0.5 text-[11px] font-semibold text-sidebar-muted-foreground/70">
                    {group.label}
                  </p>
                  <SidebarMenu className="gap-0.5 ps-px">
                    {group.paths.map((to) => {
                      const isActive = pathname === to || pathname.startsWith(`${to}/`);
                      return (
                        <SidebarMenuItem key={to}>
                          <SidebarMenuButton
                            isActive={isActive}
                            className={SETTINGS_NAV_ROW_CLASSNAME}
                            onClick={() => handleSectionClick(to)}
                          >
                            <SettingsSectionIcon to={to} />
                            <span className="truncate">{SETTINGS_SECTION_LABELS[to]}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </div>
              ))}
            </div>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-[var(--sidebar-content-inset)] py-1">
        <Suspense fallback={null}>
          <IskraConnectSidebarSignIn />
        </Suspense>
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <SidebarUtilityMenu />
          </div>
          <Suspense fallback={null}>
            <IskraConnectSidebarAvatar />
          </Suspense>
        </div>
      </SidebarFooter>
    </>
  );
}
