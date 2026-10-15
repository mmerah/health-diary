// Reads lab results from OCR text, conservatively. A line is a result only when it has a test name,
// a number and either a printed reference range or a HIGH/LOW flag:
//   "Total cholesterol   2.15 g/L    (< 2.00)    HIGH"
//   "Vitamin D (25-OH) 18 ng/mL (30 – 100) LOW"
//   "PSA 0.84 ng/mL 0.00 - 4.00"
// Lines like "Mean HR 72 bpm, min 48 bpm" (no range, no flag) are not read.

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`(?:(?:x\s?)?10\^?\d{1,2}\/[a-zA-Zµμ]+|%|[a-zA-Zµμ°/][a-zA-Zµμ°/0-9.²³^*]*(?:\/[a-zA-Zµμ0-9.²³]+)*)`;
const DASH = String.raw`(?:-|–|—|à|to)`;
const RANGE_IN = String.raw`(?:[<>≤≥]=?\s*${NUM}|${NUM}\s*${DASH}\s*${NUM})`;
const FLAG = String.raw`(?:HIGH|LOW|High|Low|HAUT|BAS|Haut|Bas|H|L|↑|↓|\+|-|\*{1,3})`;

// name, value + unit, then maybe the same value in a second unit ("4.91 mmol/L", "soit 4.91 mmol/L"),
// then a range (with or without its unit), then a flag.
const LINE_RE = new RegExp(String.raw`^\s*(?<name>[\p{L}][\p{L}\p{N} ()\-'’/,.]*?[\p{L}\p{N})])\s*[:.]?\s+(?<cmp>[<>]\s*)?(?<value>${NUM})\s*(?<unit>${UNIT})?`
  + String.raw`(?:\s*[,;/=]?\s*(?:soit|i\.e\.|or)?\s*(?<alt>${NUM})\s*(?<altunit>${UNIT}))?`
  + String.raw`\s*(?:\((?<range1>${RANGE_IN})\s*(?<runit1>${UNIT})?\)|\[(?<range2>${RANGE_IN})\s*(?<runit2>${UNIT})?\]|(?<range3>${RANGE_IN})(?:\s*(?<runit3>${UNIT}))?)?`
  + String.raw`\s*(?<flag>${FLAG})?\s*(?:[,;].*)?$`, 'u');

const num = s => Number(String(s).replace(',', '.'));

/** "(< 2.00)" → { hi: 2, op: '<' }; "30 – 100" → { lo: 30, hi: 100 }. */
export function parseRange(s) {
  if (!s) return null;
  const t = s.trim();
  let m = /^([<>≤≥])=?\s*(\d+(?:[.,]\d+)?)$/.exec(t);
  if (m) return m[1] === '<' || m[1] === '≤' ? { hi: num(m[2]), op: '<', text: t } : { lo: num(m[2]), op: '>', text: t };
  m = /^(\d+(?:[.,]\d+)?)\s*(?:-|–|—|à|to)\s*(\d+(?:[.,]\d+)?)$/.exec(t);
  if (m && num(m[1]) <= num(m[2])) return { lo: num(m[1]), hi: num(m[2]), text: t };
  return null;
}

/** 'high' | 'low' | null. A printed flag wins; otherwise the value is compared with the range. */
export function labFlag(value, range, printed) {
  const p = String(printed || '').trim();
  if (/^(HIGH|High|HAUT|Haut|H|↑|\+)$/.test(p)) return 'high';
  if (/^(LOW|Low|BAS|Bas|L|↓|-)$/.test(p)) return 'low';
  if (!range || value == null) return p.startsWith('*') ? 'flagged' : null;
  // "< 2.00" means "below 2.00", so 2.00 is already outside.
  if (range.hi != null && (range.op === '<' ? value >= range.hi : value > range.hi)) return 'high';
  if (range.lo != null && (range.op === '>' ? value <= range.lo : value < range.lo)) return 'low';
  return p.startsWith('*') ? 'flagged' : null;
}

const NOT_A_TEST = /^(?:page|date|tel|t[ée]l|fax|age|âge|sample|collected|patient|dob|born|n[ée]|file|id|ipp|recording|validated|dr|mean|min|max|average|total of|room|bed)\b/i;

const unitKey = u => String(u || '').toLowerCase().replace(/μ/g, 'µ').replace(/\s/g, '');
// A value fits a range when it is within 3 times its limits: a sign that it is in the same unit.
const fits = (v, r) => (r.hi == null || v <= r.hi * 3) && (r.lo == null || v >= r.lo / 3);

/** Lab results in one text: [{ test, key, value, valueText, cmp, unit, alt, range, rangeText, flag, line }]. */
export function parseLabs(text) {
  const out = [];
  String(text || '').split('\n').forEach((raw, index) => {
    const line = raw.replace(/\t/g, '  ').trimEnd();
    if (line.length > 140) return;
    const m = LINE_RE.exec(line);
    if (!m) return;
    const g = m.groups;
    const name = g.name.replace(/[\s.:]+$/, '').trim();
    const rangeText = g.range1 || g.range2 || g.range3 || '';
    const range = parseRange(rangeText);
    const flagText = g.flag || '';
    // A bare "-" or "+" is only a flag when a range is printed; otherwise it is too weak a sign.
    if (!range && !/^(HIGH|LOW|High|Low|HAUT|BAS|Haut|Bas|H|L|↑|↓|\*{1,3})$/.test(flagText)) return;
    if (name.length < 2 || name.length > 48 || name.split(/\s+/).length > 7 || NOT_A_TEST.test(name)) return;
    const value = num(g.value), unit = (g.unit || '').trim();
    const alt = g.alt ? { value: num(g.alt), valueText: g.alt, unit: g.altunit.trim() } : null;
    // Compare with the range only in the same unit. A range without a unit is in the first unit,
    // unless only the second value fits it. When nothing fits, no flag.
    const runit = unitKey(g.runit1 || g.runit2 || g.runit3);
    let compared = null;
    if (range) {
      if (runit && runit === unitKey(unit)) compared = value;
      else if (runit && alt && runit === unitKey(alt.unit)) compared = alt.value;
      else if (!runit && !alt) compared = value;
      else if (!runit && alt) compared = fits(value, range) ? value : fits(alt.value, range) ? alt.value : null;
    }
    // "< 5" is a detection limit: below it, nothing to flag unless the lab printed a flag.
    const flag = g.cmp && !flagText ? null : labFlag(compared, compared == null ? null : range, flagText);
    out.push({ test: name, key: labKey(name), value, valueText: g.value, cmp: (g.cmp || '').trim(), unit, alt, range, rangeText: [rangeText.trim(), g.runit1 || g.runit2 || g.runit3].filter(Boolean).join(' '), flag, line: index });
  });
  return out;
}

/** The text without its lab lines: what the document says besides the values. */
export function nonLabText(text) {
  const labLines = new Set(parseLabs(text).map(r => r.line));
  return String(text || '').split('\n').filter((l, i) => !labLines.has(i)).join('\n');
}

/** Same test across documents: "Vitamin D (25-OH)" = "VITAMIN D (25-OH)". */
export const labKey = name => name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Lab table across documents: tests as rows, document dates as columns (oldest first).
 * docs: [{ id, date, content }]. Returns { dates: [iso], rows: [{ test, unit, rangeText, cells: { iso: result } , latest }] }.
 */
export function labTable(docs) {
  const rows = new Map();
  const dates = new Set();
  for (const d of [...docs].sort((a, b) => a.date.localeCompare(b.date))) {
    const found = parseLabs(d.content);
    if (!found.length) continue;
    dates.add(d.date);
    for (const r of found) {
      const row = rows.get(r.key) || { test: r.test, key: r.key, unit: r.unit, rangeText: r.rangeText, cells: {}, order: rows.size };
      row.cells[d.date] = r;
      row.latest = r;
      row.unit = r.unit || row.unit;
      row.rangeText = r.rangeText || row.rangeText;
      rows.set(r.key, row);
    }
  }
  return { dates: [...dates].sort(), rows: [...rows.values()].sort((a, b) => a.order - b.order) };
}
