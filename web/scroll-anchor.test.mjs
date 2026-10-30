import test from "node:test";
import assert from "node:assert/strict";
import { anchorDelta, restoreAnchor } from "./scroll-anchor.js";

const spy = () => {
  const calls = [];
  return { calls, scrollBy: (delta) => calls.push(delta) };
};

test("anchorDelta is the distance the header moved on screen", () => {
  assert.equal(anchorDelta(130, 130), 0);
  assert.equal(anchorDelta(130, 430), 300);
  assert.equal(anchorDelta(430, 130), -300);
});

test("anchorDelta refuses a position it cannot trust", () => {
  for (const bad of [null, undefined, NaN, Infinity, "10", {}]) {
    assert.equal(anchorDelta(bad, 100), null);
    assert.equal(anchorDelta(100, bad), null);
  }
});

test("a header that did not move scrolls nothing", () => {
  const s = spy();
  const delta = restoreAnchor({ beforeTop: 130, measure: () => 130, scrollBy: s.scrollBy });
  assert.equal(delta, 0);
  assert.deepEqual(s.calls, []);
});

test("content growing above the header 300px scrolls down 300", () => {
  // Only FDs -> Everything: the hero and the net-worth card appear, the header
  // drops 300px down the viewport, so the page scrolls down by the same 300.
  const s = spy();
  const delta = restoreAnchor({ beforeTop: 130, measure: () => 430, scrollBy: s.scrollBy });
  assert.equal(delta, 300);
  assert.deepEqual(s.calls, [300]);
});

test("content shrinking above the header 300px scrolls up 300", () => {
  const s = spy();
  const delta = restoreAnchor({ beforeTop: 430, measure: () => 130, scrollBy: s.scrollBy });
  assert.equal(delta, -300);
  assert.deepEqual(s.calls, [-300]);
});

test("a header that moved up 120 scrolls down 120", () => {
  const s = spy();
  const delta = restoreAnchor({ beforeTop: 430, measure: () => 310, scrollBy: s.scrollBy });
  assert.equal(delta, -120);
  assert.deepEqual(s.calls, [-120]);
});

test("no before position means no anchor and no scroll", () => {
  for (const bad of [null, undefined, NaN]) {
    const s = spy();
    let measures = 0;
    const delta = restoreAnchor({
      beforeTop: bad,
      measure: () => { measures += 1; return 430; },
      scrollBy: s.scrollBy,
    });
    assert.equal(delta, null);
    assert.deepEqual(s.calls, []);
    assert.ok(measures <= 1);
  }
});

test("a header that is gone after the swap falls back to the caller", () => {
  for (const missing of [null, undefined, NaN]) {
    const s = spy();
    const delta = restoreAnchor({
      beforeTop: 130,
      measure: () => missing,
      scrollBy: s.scrollBy,
    });
    assert.equal(delta, null);
    assert.deepEqual(s.calls, []);
  }
});

test("fractional positions land on whole pixels", () => {
  assert.equal(anchorDelta(130.4, 130.6), 0);
  assert.equal(anchorDelta(100.5, 90.4), -10);
  assert.equal(anchorDelta(100.4, 90.6), -10);
  const s = spy();
  const delta = restoreAnchor({ beforeTop: 130.4, measure: () => 430.5, scrollBy: s.scrollBy });
  assert.equal(delta, 300);
  assert.ok(Number.isInteger(s.calls[0]));
});
