import assert from "node:assert/strict";
import test from "node:test";
import { nextSelectIndex, placeSelectMenu } from "../lib/select-navigation.ts";

test("dropdown keyboard navigation wraps through options", () => {
  assert.equal(nextSelectIndex(2, "ArrowDown", 3), 0);
  assert.equal(nextSelectIndex(0, "ArrowUp", 3), 2);
});

test("Home and End move to the first and last option", () => {
  assert.equal(nextSelectIndex(2, "Home", 4), 0);
  assert.equal(nextSelectIndex(0, "End", 4), 3);
  assert.equal(nextSelectIndex(0, "ArrowDown", 0), -1);
});

test("dropdown placement aligns to its trigger and stays within a narrow viewport", () => {
  assert.deepEqual(placeSelectMenu(
    { left: 270, width: 220, top: 100, bottom: 144 },
    { width: 320, height: 700 },
  ), { left: 92, width: 220, maxHeight: 240, top: 150 });
});

test("dropdown opens above a low trigger and constrains its scroll area", () => {
  assert.deepEqual(placeSelectMenu(
    { left: 24, width: 260, top: 620, bottom: 664 },
    { width: 800, height: 700 },
  ), { left: 24, width: 260, maxHeight: 240, bottom: 86 });
});
