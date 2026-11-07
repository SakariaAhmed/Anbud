import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { clampSidebarWidth, sidebarWidthForKey, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } = jiti("./project-sidebar-width.ts");

test("keyboard resizing moves, clamps, and reaches both extremes", () => {
  const width = 300;
  assert.ok(sidebarWidthForKey(width, "ArrowRight") > width);
  assert.ok(sidebarWidthForKey(width, "ArrowLeft") < width);
  assert.equal(sidebarWidthForKey(MIN_SIDEBAR_WIDTH, "ArrowLeft"), MIN_SIDEBAR_WIDTH);
  assert.equal(sidebarWidthForKey(MAX_SIDEBAR_WIDTH, "ArrowRight"), MAX_SIDEBAR_WIDTH);
  assert.equal(sidebarWidthForKey(width, "Home"), MIN_SIDEBAR_WIDTH);
  assert.equal(sidebarWidthForKey(width, "End"), MAX_SIDEBAR_WIDTH);
  assert.equal(clampSidebarWidth(-50), MIN_SIDEBAR_WIDTH);
  assert.equal(clampSidebarWidth(5000), MAX_SIDEBAR_WIDTH);
});

test("ordinary keyboard navigation is not consumed by resizing", () => {
  for (const key of ["Tab", "Escape", "ArrowUp", "ArrowDown", "Enter", "a"]) assert.equal(sidebarWidthForKey(300, key), null);
});
