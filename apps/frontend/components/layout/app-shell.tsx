"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  BriefcaseBusiness,
  ChevronDown,
  CircleUserRound,
  KeyRound,
  LogOut,
  ShieldCheck,
} from "lucide-react";

import { AppHeaderLogo } from "@/components/layout/app-header-logo";

function isChatWindow(pathname: string) {
  return /^\/projects\/[^/]+\/chat\/?$/.test(pathname);
}

function MenuLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <span className="text-slate-500 [&_svg]:size-4">{icon}</span>
      {children}
    </Link>
  );
}

export function AppShell({
  authenticated = false,
  children,
  displayName,
  isAdmin = false,
  identityType = "internal",
}: {
  authenticated?: boolean;
  children: ReactNode;
  displayName?: string | null;
  isAdmin?: boolean;
  identityType?: "internal" | "guest";
}) {
  const pathname = usePathname() ?? "";
  const isolatedChat = isChatWindow(pathname);
  const showHeader = pathname !== "/login" && !isolatedChat;
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const userLabel = displayName?.trim() || "Bruker";

  useEffect(() => {
    if (pathname === "/") document.body.dataset.route = "home";
    else delete document.body.dataset.route;
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  async function logOut() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  }

  if (isolatedChat) return <div className="min-h-screen">{children}</div>;

  return (
    <div className="min-h-screen">
      {showHeader ? (
        <header
          className="fixed inset-x-0 top-0 z-[60] border-b border-slate-700 bg-slate-900"
          data-app-header="true"
        >
          <div className="flex h-[var(--app-header-height)] items-center justify-between px-4 sm:px-6 lg:px-10">
            <AppHeaderLogo />
            <div className="flex items-center gap-2">
              {isAdmin ? (
                <Link
                  href="/admin"
                  className="inline-flex h-8 items-center gap-2 rounded-md border border-cyan-300/25 bg-cyan-300/10 px-3 text-sm font-medium text-cyan-50 hover:bg-cyan-300/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
                >
                  <ShieldCheck className="size-4" />
                  <span className="hidden sm:inline">Styring og innsikt</span>
                </Link>
              ) : null}

              {authenticated ? (
                <div className="relative border-l border-white/15 pl-2">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((value) => !value)}
                    className="flex h-9 items-center gap-2 rounded-md px-1.5 text-slate-200 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
                  >
                    <span className="grid size-7 place-items-center rounded-md bg-blue-400/15 text-xs font-semibold uppercase text-blue-100">
                      {userLabel.charAt(0)}
                    </span>
                    <span className="hidden max-w-44 truncate text-sm md:block">
                      {userLabel}
                    </span>
                    <ChevronDown
                      className={`hidden size-3.5 text-slate-400 transition-transform md:block ${menuOpen ? "rotate-180" : ""}`}
                    />
                  </button>

                  {menuOpen ? (
                    <div
                      role="menu"
                      className="absolute right-0 top-[calc(100%+0.5rem)] w-60 rounded-md border border-slate-200 bg-white p-1.5 text-slate-900 shadow-xl shadow-slate-950/20"
                    >
                      <div className="px-2.5 py-2">
                        <p className="truncate text-sm font-semibold">
                          {userLabel}
                        </p>
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                          {identityType === "guest" ? (
                            <KeyRound className="size-3" />
                          ) : (
                            <ShieldCheck className="size-3" />
                          )}
                          {identityType === "guest"
                            ? "Gjestekonto"
                            : isAdmin
                              ? "Microsoft-konto · Administrator"
                              : "Microsoft-konto"}
                        </p>
                      </div>
                      <nav
                        className="border-t border-slate-100 pt-1.5"
                        aria-label="Brukernavigasjon"
                      >
                        <MenuLink
                          href="/profile"
                          icon={<CircleUserRound />}
                        >
                          Min profil
                        </MenuLink>
                        <MenuLink href="/" icon={<BriefcaseBusiness />}>
                          Mine prosjekter
                        </MenuLink>
                        {isAdmin ? (
                          <MenuLink href="/admin" icon={<ShieldCheck />}>
                            Styring og innsikt
                          </MenuLink>
                        ) : null}
                      </nav>
                      <div className="mt-1.5 border-t border-slate-100 pt-1.5">
                        <button
                          type="button"
                          onClick={() => void logOut()}
                          disabled={loggingOut}
                          className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-wait disabled:opacity-60"
                        >
                          <LogOut className="size-4 text-slate-500" />
                          {loggingOut ? "Logger ut …" : "Logg ut"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </header>
      ) : null}
      <main
        className={
          showHeader
            ? "site-reload-enter pt-[var(--app-header-height)]"
            : undefined
        }
      >
        {children}
      </main>
    </div>
  );
}
