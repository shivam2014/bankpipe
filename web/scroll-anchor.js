// Keeps a section header in the same viewport position when the content above
// it changes height. The Assets view swaps its whole DOM on a Sort or Show
// click, and the Everything mode renders a hero and a net-worth card that the
// FD-only mode does not, so a saved pixel offset lands on different content.
// The header's own position on screen is the stable thing to remember.
//
// Kept DOM-free so the arithmetic can be tested without a browser.

export function anchorDelta(beforeTop, afterTop) {
  if (!Number.isFinite(beforeTop) || !Number.isFinite(afterTop)) return null;
  // One whole-pixel step: fractional rects would otherwise leave a subpixel
  // remainder behind on every re-render.
  return Math.round(afterTop - beforeTop);
}

export function restoreAnchor({ beforeTop, measure, scrollBy } = {}) {
  if (typeof measure !== "function") return null;
  const delta = anchorDelta(beforeTop, measure());
  if (delta === null) return null;
  // A header that did not move needs no scroll event at all.
  if (delta !== 0 && typeof scrollBy === "function") scrollBy(delta);
  return delta;
}
