const test = require("node:test");
const assert = require("node:assert/strict");

let lineDiff;

test.before(async () => {
  ({ lineDiff } = await import("../../src/utils/lineDiff.ts"));
});

const lines = (diff) => diff.map(({ kind, text }) => `${kind}${text}`);

test("unchanged, added and removed lines come out in order", () => {
  assert.deepEqual(lines(lineDiff("a\nb\nc", "a\nc\nd")), [" a", "-b", " c", "+d"]);
  assert.deepEqual(lines(lineDiff("Keep\nold rule\nEnd\n", "Keep\nnew rule\nEnd\n")), [
    " Keep",
    "-old rule",
    "+new rule",
    " End",
  ]);
  assert.deepEqual(lines(lineDiff("", "First\r\nSecond")), ["+First", "+Second"]);
});

test("identical texts give only unchanged lines", () => {
  assert.deepEqual(lineDiff("x\ny\n", "x\ny\n"), [
    { kind: " ", text: "x" },
    { kind: " ", text: "y" },
  ]);
});

test("inputs over 2,000 lines fall back to whole removed and added blocks", () => {
  const before = Array.from({ length: 2_001 }, (_, index) => `line ${index}`);
  const after = [...before.slice(0, 1_000), "changed", ...before.slice(1_001)];

  const diff = lineDiff(before.join("\n"), after.join("\n"));

  assert.equal(diff.length, 4_002);
  assert.deepEqual(diff.slice(0, 2_001), before.map((text) => ({ kind: "-", text })));
  assert.deepEqual(diff.slice(2_001), after.map((text) => ({ kind: "+", text })));
});
