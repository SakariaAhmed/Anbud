const PROJECT_WORKSPACE_UI_SCALE = 0.9;
export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MIN_SIDEBAR_WIDTH = Math.round(270 * PROJECT_WORKSPACE_UI_SCALE);
export const MAX_SIDEBAR_WIDTH = Math.round(440 * PROJECT_WORKSPACE_UI_SCALE);
const KEYBOARD_RESIZE_STEP = 16;

export function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

/** Null leaves ordinary navigation keys to the browser. */
export function sidebarWidthForKey(width: number, key: string): number | null {
  switch (key) {
    case "ArrowLeft": return clampSidebarWidth(width - KEYBOARD_RESIZE_STEP);
    case "ArrowRight": return clampSidebarWidth(width + KEYBOARD_RESIZE_STEP);
    case "Home": return MIN_SIDEBAR_WIDTH;
    case "End": return MAX_SIDEBAR_WIDTH;
    default: return null;
  }
}
