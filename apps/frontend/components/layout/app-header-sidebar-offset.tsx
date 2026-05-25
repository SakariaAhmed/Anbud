"use client";

import { useEffect } from "react";

const SIDEBAR_WIDTH_STORAGE_KEY = "project-workspace-sidebar-width-v2";
const DEFAULT_SIDEBAR_WIDTH = 255;
const COLLAPSED_SIDEBAR_WIDTH = 56;
const MIN_SIDEBAR_WIDTH = 255;
const MAX_SIDEBAR_WIDTH = 440;

function clampSidebarWidth(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value));
}

function readSidebarOpen() {
  return !document.cookie
    .split(";")
    .map((item) => item.trim())
    .includes("sidebar_state=false");
}

function readSidebarWidth() {
  try {
    return clampSidebarWidth(
      Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)),
    );
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function syncHeaderOffset() {
  const open = readSidebarOpen();
  const width = open ? readSidebarWidth() : COLLAPSED_SIDEBAR_WIDTH;
  document.documentElement.style.setProperty(
    "--app-header-sidebar-offset",
    `${width}px`,
  );
}

export function AppHeaderSidebarOffset() {
  useEffect(() => {
    syncHeaderOffset();

    const onStorage = (event: StorageEvent) => {
      if (event.key === SIDEBAR_WIDTH_STORAGE_KEY) {
        syncHeaderOffset();
      }
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("project-sidebar-layout-change", syncHeaderOffset);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(
        "project-sidebar-layout-change",
        syncHeaderOffset,
      );
    };
  }, []);

  return null;
}
