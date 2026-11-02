/**
 * Indexes of the tabs that show: all when they fit; else a prefix that leaves room for the more button, with the selected tab kept
 * (it replaces the last tabs of the prefix it does not fit after). Unknown width (undefined): all.
 */
export function fitTabs(widths: number[], avail: number | undefined, gap: number, more: number, selected: number): number[] {
  const all = widths.map((_, i) => i);
  if (avail === undefined || widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, widths.length - 1) <= avail) return all;
  const budget = avail - more - gap;
  const size = (ix: number[]) => ix.reduce((a, i) => a + widths[i]!, 0) + gap * Math.max(0, ix.length - 1);
  const taken: number[] = [];
  for (const i of all) {
    if (size([...taken, i]) > budget) break;
    taken.push(i);
  }
  if (selected >= 0 && !taken.includes(selected)) {
    while (taken.length && size([...taken, selected]) > budget) taken.pop();
    taken.push(selected);
  }
  return taken.length || !all.length ? taken : [0];
}
