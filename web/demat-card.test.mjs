import test from "node:test";
import assert from "node:assert/strict";

import { dematText } from "./demat-card.js";

test("a quote-only Demat is empty text, not two quote characters", () => {
  assert.equal(dematText('""'), "");
});

test("a quoted or padded Demat reads as its number", () => {
  assert.equal(dematText('"1200000012345678"'), "1200000012345678");
  assert.equal(dematText("  "), "");
});
