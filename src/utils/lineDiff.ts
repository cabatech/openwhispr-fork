export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
}

// The table below grows with both line counts; past this, whole blocks are shown instead.
const MAX_DIFF_LINES = 2_000;

function toLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The line-by-line changes from `before` to `after`, in order, removals before additions. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const removed = toLines(before);
  const added = toLines(after);
  if (removed.length > MAX_DIFF_LINES || added.length > MAX_DIFF_LINES) {
    return [
      ...removed.map((text): DiffLine => ({ kind: "-", text })),
      ...added.map((text): DiffLine => ({ kind: "+", text })),
    ];
  }

  // common[i * width + j]: the longest run of lines removed[i…] and added[j…] share.
  const width = added.length + 1;
  const common = new Uint16Array((removed.length + 1) * width);
  for (let i = removed.length - 1; i >= 0; i -= 1) {
    for (let j = added.length - 1; j >= 0; j -= 1) {
      common[i * width + j] =
        removed[i] === added[j]
          ? common[(i + 1) * width + j + 1] + 1
          : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < removed.length && j < added.length) {
    if (removed[i] === added[j]) {
      diff.push({ kind: " ", text: removed[i] });
      i += 1;
      j += 1;
    } else if (common[(i + 1) * width + j] >= common[i * width + j + 1]) {
      diff.push({ kind: "-", text: removed[i] });
      i += 1;
    } else {
      diff.push({ kind: "+", text: added[j] });
      j += 1;
    }
  }
  for (; i < removed.length; i += 1) diff.push({ kind: "-", text: removed[i] });
  for (; j < added.length; j += 1) diff.push({ kind: "+", text: added[j] });
  return diff;
}
