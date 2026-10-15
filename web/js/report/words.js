// The sentences of the report, shared by the markdown and the HTML renderers.
// Every function returns plain text. The HTML renderer escapes it.
// h = { D(iso) → date text, T(text) → user text (redacted in AI mode), ai: boolean }
import { PERIODS, severityLabel } from '../core/schema.js';
import { counterList, measurementDefOf } from './stats.js';
import { duration, num, plural } from '../core/format.js';

export const pct = r => `${Math.round(r * 100)}%`;
export const one = v => (v == null ? '–' : Number(v).toFixed(1));

/** Median severity in words: 1.5 → "mild to moderate". */
export function severityWords(v) {
  if (v == null) return 'not set';
  if (Number.isInteger(v)) return severityLabel(v).toLowerCase();
  return `${severityLabel(Math.floor(v)).toLowerCase()} to ${severityLabel(Math.ceil(v)).toLowerCase()}`;
}

export const sevShort = v => (v ? severityLabel(v).toLowerCase() : 'severity not set');

export function measurementText(m) {
  return measurementDefOf(m.type).format(m.value);
}

export const LEVEL_WORD = { high: 'High', caution: 'Check', info: 'Note' };

/** A flag as { area, text }. */
export function flagText(f, h) {
  const { D, T } = h;
  switch (f.kind) {
    case 'bp-high': return { area: 'Blood pressure',
      text: `${f.count} of ${plural(f.total, 'reading')} at 140/90 mmHg or above. Highest: ${f.worst.value.sys}/${f.worst.value.dia} on ${D(f.worst.date)}.` };
    case 'bp-low': return { area: 'Blood pressure', text: `${f.count} of ${plural(f.total, 'reading')} under 90/60 mmHg.` };
    case 'fever': return { area: 'Temperature',
      text: `${plural(f.episodes.length, 'episode')} of fever (38 °C or above): ${f.episodes.map(e => `${D(e.from)}${e.to !== e.from ? ` to ${D(e.to)}` : ''}, highest ${one(e.max)} °C`).join('; ')}.` };
    case 'weight': {
      const c = f.change;
      return { area: 'Weight', text: `${c.kg > 0 ? 'Up' : 'Down'} ${one(Math.abs(c.kg))} kg (${c.pct > 0 ? '+' : '−'}${one(Math.abs(c.pct))}%): ${one(c.from.value)} kg on ${D(c.from.date)}, ${one(c.to.value)} kg on ${D(c.to.date)}.` };
    }
    case 'symptom-new': return { area: T(f.symptom.name),
      text: `New in the second half of the period: ${halves(f.symptom)}.` };
    case 'symptom-more': return { area: T(f.symptom.name), text: `More frequent in the second half: ${halves(f.symptom)}.` };
    case 'symptom-worse': return { area: T(f.symptom.name), text: `More severe in the second half of the period (${halves(f.symptom)}).` };
    case 'symptom-severe': {
      const s = f.symptom;
      const dates = s.severeDates;
      return { area: T(s.name), text: `Severe on ${plural(dates.length, 'day')}: ${dates.slice(-5).map(D).join(', ')}${dates.length > 5 ? ' (last 5)' : ''}.` };
    }
    case 'missed-med': return { area: T(medName(f.med)),
      text: `Taken on ${f.med.taken} of ${plural(f.med.eligible, 'day')} (${pct(f.med.rate)}). Only days where the medication part of the diary was filled in count.` };
    case 'lab': {
      const r = f.row.latest;
      return { area: T(f.row.test), text: `${labValue(r)} on ${D(f.date)}: ${r.flag === 'flagged' ? 'flagged by the lab' : r.flag}${r.rangeText ? ` (range ${r.rangeText})` : ''}.` };
    }
    case 'lab-resolved': {
      const [date, r] = f.earlier;
      return { area: T(f.row.test), text: `Was ${r.flag === 'flagged' ? 'flagged' : r.flag} (${labValue(r)}) on ${D(date)}. Latest: ${labValue(f.row.latest)} on ${D(f.date)}, in range.` };
    }
    case 'association': {
      const a = f.assoc;
      const lab = x => (a.factor === 'coffee' ? `${x} of coffee` : a.factor === 'sleep' ? `${x} of sleep the night before` : x);
      return { area: T(a.symptom), text: `On ${a.a.with} of ${plural(a.a.days, 'day')} with ${lab(a.aLabel)}, on ${a.b.with} of ${plural(a.b.days, 'day')} with ${lab(a.bLabel)}. This is a pattern, not a cause.` };
    }
    case 'custom-range': {
      const parts = [f.above && `above your range on ${f.above} of ${plural(f.total, 'reading')}`, f.below && `below your range on ${f.below} of ${plural(f.total, 'reading')}`].filter(Boolean);
      return { area: T(f.label), text: `${parts.join(', ').replace(/^./, c => c.toUpperCase())}. Highest: ${measurementText(f.worst)} on ${D(f.worst.date)}.` };
    }
    case 'oxygen-low-nights': return { area: 'Blood oxygen',
      text: `Lowest value under 90 % on ${plural(f.days.length, 'day')}: ${f.days.slice(-6).map(x => `${D(x.date)} (${x.value} %)`).join(', ')}${f.days.length > 6 ? ' (last 6)' : ''}. Wearable estimate.` };
    case 'oxygen-low-mean': return { area: 'Blood oxygen', text: `Average ${one(f.value)} % over the period (under 94 %). Wearable estimate.` };
    case 'respiratory-high': return { area: 'Respiratory rate', text: `Average ${one(f.value)} breaths a minute over the period (above 20). Wearable estimate.` };
    case 'hr-up': return { area: 'Resting heart rate', text: `Median went up from ${Math.round(f.first)} to ${Math.round(f.last)} bpm (first 4 weeks, last 4 weeks).` };
    case 'sleep-down': return { area: 'Sleep', text: `Median sleep went down from ${duration(f.first)} to ${duration(f.last)} (first 4 weeks, last 4 weeks).` };
    default: return { area: f.kind, text: '' };
  }
}

function halves(s) {
  const h = s.halves;
  return `${h.first} of ${plural(h.loggedFirst, 'diary day')} in the first half, ${h.second} of ${h.loggedSecond} in the second half`;
}

export const medName = m => [m.name, m.dose].filter(Boolean).join(' ');
export const labValue = r => `${r.cmp ? `${r.cmp} ` : ''}${r.valueText || String(r.value)}${r.unit ? ` ${r.unit}` : ''}`;

// ---------- Section sentences

export function severityText(s) {
  const parts = [1, 2, 3].filter(v => s.severity[v]).map(v => `${severityLabel(v).toLowerCase()} ${s.severity[v]}`);
  if (s.severity.unset) parts.push(`not set ${s.severity.unset}`);
  return parts.join(', ');
}

export function whenText(s) {
  const order = ['day', ...PERIODS.map(p => p.key), 'unknown'];
  const name = { day: 'all day', unknown: 'time not set' };
  return order.filter(k => s.when[k]).map(k => `${name[k] || k} ${s.when[k]}`).join(', ');
}

export const TREND = { new: 'new in the second half', more: 'more frequent in the second half', worse: 'more severe in the second half',
  less: 'less frequent in the second half', stable: 'no clear change' };

export function drinkText(d) {
  const unit = n => (Number(n) === 1 ? d.one : d.many);
  const parts = [`recorded on ${plural(d.recorded, 'day')}`];
  if (d.key === 'alcohol') {
    parts.push(`alcohol on ${plural(d.daysAny, 'day')}`);
    if (d.daysAny) parts.push(`average ${one(d.average)} ${d.many} a day`, `most in one day: ${d.max} ${unit(d.max)}`, `5 or more: ${plural(d.daysHeavy, 'day')}`);
  } else {
    parts.push(`average ${one(d.average)} ${d.many} a day`, `most in one day: ${d.max} ${unit(d.max)}`);
    if (d.key === 'coffee') parts.push(`3 or more cups: ${plural(d.daysThreePlus, 'day')}`);
  }
  return parts.join(', ');
}

/** "6/3/0/1" for the compact AI table: the counters in `list` order, "–" when not recorded. */
export const drinksShort = (drinks, list = counterList()) => (drinks ? list.map(d => (drinks[d.key] == null ? '–' : drinks[d.key])).join('/') : '');

export function adherenceText(m) {
  if (!m.eligible) return 'no diary days while it was active';
  return `taken on ${m.taken} of ${plural(m.eligible, 'diary day')} (${pct(m.rate)})${m.usualTime ? `, usually at ${m.usualTime}` : ''}`;
}

export function asNeededText(m) {
  if (!m.uses) return 'not used in the period';
  return `${plural(m.uses, 'time')} on ${plural(m.days, 'day')}${m.usualTime ? `, usually at ${m.usualTime}` : ''}`;
}

export const stepsText = (v, ai) => (v == null ? '–' : ai ? `${(v / 1000).toFixed(1)}k` : num(Math.round(v)));
export const sleepText = v => (v == null ? '–' : duration(v));
export { duration, num, plural };
