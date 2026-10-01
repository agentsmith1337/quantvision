"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { API_BASE } from "@/lib/api";
import { AuthProvider, useAuth } from "@/lib/auth";
import { BrokerStatusProvider, useBrokerStatus } from "@/lib/broker-status";
import { ActivityBar } from "./activity-bar";
import { ExecutionSidecard } from "./execution-sidecard";
import { FeedBadge } from "./feed-badge";
import { SymbolSearch } from "./symbol-search";

type NavItem = { href: string; label: string; icon: string; phase?: number };

const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: "M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { href: "/portfolio/", label: "Portfolio", icon: "M4 7h16v12H4zM9 7V5h6v2M4 12h16" },
  { href: "/trade/", label: "Trading Dashboard", icon: "M4 19V5m0 14h16M8 15l3-4 3 2 5-6" },
  { href: "/backtest/", label: "Backtesting Studio", icon: "M8 6 3 12l5 6M16 6l5 6-5 6M13.5 4l-3 16", phase: 4 },
];

const PUBLIC_ROUTES = ["/signin", "/setup"];

function Icon({ d, className = "size-5" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}

const SIDEBAR_KEY = "qv.sidebar.collapsed";

// Sidebar preference lives in localStorage (per-browser convenience only).
const sidebarListeners = new Set<() => void>();
const sidebarPref = {
  get: () => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  },
  set: (collapsed: boolean) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch {}
    sidebarListeners.forEach((cb) => cb());
  },
  subscribe: (cb: () => void) => {
    sidebarListeners.add(cb);
    return () => sidebarListeners.delete(cb);
  },
};

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AuthGate>{children}</AuthGate>
    </AuthProvider>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, error } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));

  // Where this visitor should be, given their session state.
  let target: string | null = null;
  if (status && !status.setup_complete && !pathname.startsWith("/setup")) target = "/setup/";
  else if (status && status.setup_complete && !status.signed_in && !pathname.startsWith("/signin")) target = "/signin/";
  else if (status?.signed_in && pathname.startsWith("/signin")) target = "/";

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (error) return <Splash>{error}</Splash>;
  if (!status || target) return <Splash>Loading…</Splash>;
  if (!status.signed_in && isPublic) return <>{children}</>;

  return (
    <BrokerStatusProvider>
      <Shell>{children}</Shell>
      <ExecutionSidecard />
    </BrokerStatusProvider>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return <div className="grid h-dvh place-items-center p-6 text-center text-sm text-muted">{children}</div>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const collapsed = useSyncExternalStore(sidebarPref.subscribe, sidebarPref.get, () => false);
  const toggle = () => sidebarPref.set(!collapsed);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href.replace(/\/$/, "")));

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className={`flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 ${collapsed ? "w-16" : "w-60"}`}>
        <div className="flex h-14 items-center gap-3 px-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" className="size-9 shrink-0 rounded-lg" />
          {!collapsed && <span className="font-display text-lg font-semibold tracking-tight">QuantVision</span>}
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-2">
          {NAV.map((item) => {
            const base = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm";
            const content = (
              <>
                <Icon d={item.icon} className="size-5 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
                {!collapsed && item.phase && <span className="ml-auto rounded bg-surface-2 px-1.5 text-[10px] text-muted">Phase {item.phase}</span>}
              </>
            );
            if (item.phase) {
              return (
                <span key={item.href} className={`${base} cursor-not-allowed text-muted/60`} title={`${item.label} arrives in Phase ${item.phase}`}>
                  {content}
                </span>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? item.label : undefined}
                className={`${base} ${isActive(item.href) ? "bg-accent/15 font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
              >
                {content}
              </Link>
            );
          })}
        </nav>
        <button
          onClick={toggle}
          className="m-2 flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <Icon d={collapsed ? "m9 6 6 6-6 6" : "m15 6-6 6 6 6"} className="size-5 shrink-0" />
          {!collapsed && <span>Collapse</span>}
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
          <GlobalSearch />
          <div className="flex-1" />
          <ModeBadge />
          <FeedBadge />
          <ProfileMenu />
          <ActivityBar />
        </header>
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

const SEARCH_ID = "qv-global-search";

/** One stock search for the whole app: picking a result opens it in the Trading view. */
function GlobalSearch() {
  const router = useRouter();

  // "/" focuses the search from anywhere (unless the user is typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (target.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      document.getElementById(SEARCH_ID)?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SymbolSearch
      id={SEARCH_ID}
      className="w-full max-w-md"
      placeholder="Search stocks and indices…  ( / )"
      onSelect={(inst) => router.push(`/trade/?symbol=${encodeURIComponent(inst.symbol)}`)}
    />
  );
}

export function ModeBadge({ className = "" }: { className?: string }) {
  const { status } = useBrokerStatus();
  if (!status) return null;
  const live = status.trading_mode === "live";
  return (
    <Link
      href="/setup/#preferences"
      title={live ? "Orders go to Angel One with real money" : "Orders are simulated against live prices; no real money"}
      className={`rounded-full px-3 py-1 text-xs font-semibold tracking-wide ${live ? "bg-down/15 text-down ring-1 ring-down/40" : "bg-accent/15 text-accent"} ${className}`}
    >
      {live ? "LIVE TRADING" : "PAPER TRADING"}
    </Link>
  );
}

const THEMES = [
  { id: "day", label: "Day" },
  { id: "evening", label: "Evening" },
  { id: "dark", label: "Dark" },
];

export function Avatar({ size = "size-9" }: { size?: string }) {
  const { status, avatarVersion } = useAuth();
  const user = status?.user;
  if (user?.has_avatar) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`${API_BASE}/api/auth/avatar?v=${avatarVersion}`} alt="" className={`${size} rounded-full object-cover`} />;
  }
  return (
    <span className={`${size} flex items-center justify-center rounded-full bg-accent text-sm font-semibold uppercase text-accent-fg`}>
      {(user?.username ?? "QV").slice(0, 2)}
    </span>
  );
}

function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();
  const { status, signOut } = useAuth();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const item = "flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2";

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="rounded-full ring-offset-2 ring-offset-surface hover:ring-2 hover:ring-accent/40" aria-label="Account options" aria-expanded={open}>
        <Avatar />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-64 rounded-xl border border-border bg-surface p-2 shadow-xl">
          <div className="flex items-center gap-3 px-3 py-2">
            <Avatar size="size-8" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{status?.user?.username}</div>
              <div className="text-xs text-muted">Local account</div>
            </div>
          </div>
          <div className="my-1 border-t border-border" />
          <Link href="/setup/" className={item} onClick={() => setOpen(false)}>
            Settings
          </Link>
          <Link href="/setup/#broker" className={item} onClick={() => setOpen(false)}>
            API Configuration
          </Link>
          <div className="my-1 border-t border-border" />
          <div className="px-3 pb-1 pt-2 text-xs text-muted">Theme</div>
          <div className="grid grid-cols-3 gap-1 px-2 pb-2">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                className={`rounded-md px-2 py-1.5 text-xs ${theme === t.id ? "bg-accent text-accent-fg" : "bg-surface-2 hover:text-fg"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-border" />
          <button className={`${item} text-down`} onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
