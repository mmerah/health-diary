// Small statistics used by the report and the Trends screen.

const nums = xs => xs.filter(x => x != null && !Number.isNaN(Number(x))).map(Number);

export function mean(xs) {
  const a = nums(xs);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

export function median(xs) {
  const a = nums(xs).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
