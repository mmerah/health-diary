// Builds the markdown health report. Pure functions: the same input always gives the same output.
(function () {
  const { Dates, fmtMin, hmToMin, minToHm, pad, num } = U;

  const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Spellings of the date of birth that can appear in documents.
  function dobVariants(dob) {
    if (!dob) return [];
    const [y, m, d] = dob.split('-');
    const dd = String(Number(d)), mm = String(Number(m));
    return [dob, `${d}/${m}/${y}`, `${dd}/${mm}/${y}`, `${d}.${m}.${y}`, `${m}/${d}/${y}`];
  }

  // Removes names, contact details, IDs and the date of birth from free text.
  function makeRedactor(profile, extraWords) {
    // Full name and extra words: any case. Single name parts: only with a capital letter,
    // so a first name like "Rose" does not hide the word "rose".
    const terms = new Set(), parts = new Set();
    const name = (profile.name || '').trim();
    if (name) {
      terms.add(name);
      name.split(/\s+/).filter(w => w.length > 2).forEach(w => parts.add(w));
    }
    (extraWords || []).map(w => w.trim()).filter(Boolean).forEach(w => terms.add(w));
    const sorted = [...terms].map(t => [t, 'giu'])
      .concat([...parts].map(t => [t[0].toUpperCase() + t.slice(1), 'gu']), [...parts].map(t => [t.toUpperCase(), 'gu']))
      .sort((a, b) => b[0].length - a[0].length);
    const dobs = dobVariants(profile.dob);

    return function redact(text) {
      if (!text) return '';
      let t = String(text);
      for (const p of dobs) t = t.split(p).join('[date of birth]');
      t = t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]');
      for (const [term, flags] of sorted) t = t.replace(new RegExp(`(^|[^\\p{L}])${reEscape(term)}(?![\\p{L}])`, flags), '$1[redacted]');
      // "Dr. L. Petit", "Dr Claire Martin" -> "Dr. [name]"
      t = t.replace(/\b(Dr|Doctor|Pr|Prof|Professor|Mr|Mrs|Ms|Mme)\.?\s+(?:\[redacted\]\s*|[A-Z][\w'-]*\.?\s*){1,3}/g,
        (m, title) => `${title}. [name]${/\s$/.test(m) ? ' ' : ''}`);
      // Phone numbers, file and sample numbers: 8 or more digits in one group.
      // ISO dates inside a match do not count as digits.
      t = t.replace(/\+?\d[\d .-]{6,}\d/g, m =>
        (m.replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/\D/g, '').length >= 8 ? '[number]' : m));
      return t;
    };
  }

  // "D0" is the last day of the report, "D-7" one week before.
  const relDate = (date, end) => { const n = Dates.diff(date, end); return n === 0 ? 'D0' : `D${n}`; };

  // Dates inside document text. Slash dates are read as day/month/year.
  function relativizeText(t, end) {
    t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, m => relDate(m, end));
    return t.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m, d, mo, y) =>
      (Number(mo) <= 12 && Number(d) <= 31 ? relDate(`${y}-${pad(mo)}-${pad(d)}`, end) : m));
  }

  const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const lines = s => String(s || '').split('\n').map(l => l.trim()).filter(Boolean);
  const SEV = ['', 'mild', 'moderate', 'severe'];
  const MLABEL = {
    weight: v => `Weight ${v} kg`,
    bp: v => `Blood pressure ${v.sys}/${v.dia} mmHg${v.pulse ? `, pulse ${v.pulse}` : ''}`,
    temp: v => `Temperature ${Number(v).toFixed(1)} °C`,
  };
  // "all day", "morning and evening", "15:10–15:20"
  function describeWhen(s) {
    if (s.when === 'day') return 'all day';
    if (s.when === 'periods' && s.periods && s.periods.length) {
      const p = U.PERIODS.filter(x => s.periods.includes(x));
      return p.length > 1 ? `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}` : p[0];
    }
    if (s.when === 'time' && s.from) return s.to ? `${s.from}–${s.to}` : s.from;
    return s.time || '';
  }
  // Periods a symptom touched, for the summary.
  function periodsOf(s) {
    if (s.when === 'periods') return s.periods || [];
    if (s.when === 'time' && s.from) return [U.periodOf(s.from)];
    return [];
  }
  const bmiOf = (kg, cm) => (kg && cm ? Math.round((kg / ((cm / 100) ** 2)) * 10) / 10 : null);

  // data: { profile, days, measurements, documents }
  function buildReport(data, o) {
    const byType = t => data.measurements.filter(m => m.type === t);
    data = { ...data, weights: byType('weight'), bp: byType('bp'), temps: byType('temp') };
    const llm = o.mode === 'llm';
    const rel = llm && o.relativeDates;
    const end = o.to;
    const redact = llm ? makeRedactor(data.profile, o.redactWords) : (s => s || '');
    const D = date => (rel ? relDate(date, end) : date);
    const T = s => { let t = redact(s); if (rel) t = relativizeText(t, end); return t; };
    const inc = o.include;
    const p = data.profile || {};
    const days = data.days.filter(d => d.date >= o.from && d.date <= o.to);
    const out = [];

    // ----- Header
    out.push('# Health report', '');
    out.push(`- Period: ${D(o.from)} to ${D(o.to)} (${Dates.diff(o.to, o.from) + 1} days)`);
    if (rel) out.push('- Dates are days relative to the last day of the period (D0). D-7 is one week before D0.');
    if (llm) out.push('- Personal details are removed: names, IDs, contact details and date of birth.');
    out.push('- Sources: daily diary (self-reported), Apple Health (sleep, steps, heart rate), medical documents.', '');

    if (o.question && o.question.trim()) out.push('## Question', '', T(o.question.trim()), '');

    // ----- Profile
    const weights = data.weights.filter(w => w.date <= end);
    const lastW = weights[weights.length - 1];
    if (inc.profile) {
      out.push('## Profile', '');
      if (!llm && p.name) out.push(`- Name: ${p.name}`);
      if (p.dob) out.push(llm ? `- Age: ${Dates.age(p.dob, end)}` : `- Date of birth: ${p.dob} (age ${Dates.age(p.dob, end)})`);
      if (p.sex) out.push(`- Sex: ${p.sex}`);
      if (p.ethnicity) out.push(`- Ethnicity: ${T(p.ethnicity)}`);
      if (p.heightCm) out.push(`- Height: ${p.heightCm} cm`);
      if (lastW) out.push(`- Latest weight: ${lastW.value} kg (${D(lastW.date)}), BMI ${bmiOf(lastW.value, p.heightCm) ?? '–'}`);
      const sections = [['Conditions and diagnoses', p.conditions], ['Regular medication', p.medications],
        ['Allergies', p.allergies], ['Surgeries and hospital stays', p.surgeries], ['Family history', p.familyHistory],
        ['Lifestyle and other notes', p.lifestyle]];
      for (const [title, text] of sections) {
        const ls = lines(text);
        if (ls.length) out.push('', `### ${title}`, ...ls.map(l => `- ${T(l)}`));
      }
      out.push('');
    }

    // ----- Summary of the period
    if (inc.health || inc.log) {
      out.push('## Summary of the period', '');
      const logged = days.filter(d => d.log && hasContent(d.log));
      if (inc.log) out.push(`- Days with a diary entry: ${logged.length} of ${Dates.diff(o.to, o.from) + 1}`);
      if (inc.health) {
        const h = days.map(d => d.health).filter(Boolean);
        const sl = h.map(x => x.sleep && x.sleep.total).filter(Boolean);
        if (sl.length) out.push(`- Sleep: average ${fmtMin(avg(sl))} a night (shortest ${fmtMin(Math.min(...sl))}, longest ${fmtMin(Math.max(...sl))}, ${sl.length} night${sl.length > 1 ? 's' : ''})`);
        const beds = h.map(x => x.sleep && hmToMin(x.sleep.bed)).filter(v => v != null).map(v => (v < 12 * 60 ? v + 1440 : v));
        if (beds.length) out.push(`- Average bedtime: ${minToHm(avg(beds))}`);
        const st = h.map(x => x.steps).filter(Boolean);
        if (st.length) out.push(`- Steps: average ${num(Math.round(avg(st)))} a day`);
        const hr = h.map(x => x.restingHr).filter(Boolean);
        if (hr.length) out.push(`- Resting heart rate: average ${Math.round(avg(hr))} bpm (${Math.min(...hr)}–${Math.max(...hr)})`);
        const hv = h.map(x => x.hrv).filter(Boolean);
        if (hv.length) out.push(`- Heart rate variability (HRV, SDNN): average ${Math.round(avg(hv))} ms (${Math.min(...hv)}–${Math.max(...hv)})`);
      }
      if (inc.log) {
        const sym = {};
        logged.forEach(d => {
          const seen = new Set();
          (d.log.symptoms || []).forEach(s => {
            const e = sym[s.name] = sym[s.name] || { days: 0, n: 0, sev: 0, worst: 0, allDay: 0, when: {} };
            e.n++; e.sev += s.severity || 1; e.worst = Math.max(e.worst, s.severity || 1);
            if (s.when === 'day') e.allDay++;
            periodsOf(s).forEach(x => { e.when[x] = (e.when[x] || 0) + 1; });
            if (!seen.has(s.name)) { e.days++; seen.add(s.name); }
          });
        });
        const top = Object.entries(sym).sort((a, b) => b[1].days - a[1].days);
        if (top.length) {
          out.push('- Symptoms:');
          top.forEach(([n, e]) => {
            const timing = [...(e.allDay ? [`all day ${e.allDay}×`] : []),
              ...U.PERIODS.filter(x => e.when[x]).map(x => `${x} ${e.when[x]}×`)];
            out.push(`  - ${T(n)}: ${e.days} day${e.days > 1 ? 's' : ''}, usually ${SEV[Math.round(e.sev / e.n)]}, worst ${SEV[e.worst]}${timing.length ? `. When: ${timing.join(', ')}` : ''}`);
          });
        }
        const drinks = k => logged.map(d => d.log.drinks && d.log.drinks[k]).filter(v => v != null);
        const w = drinks('water'), c = drinks('coffee'), a = drinks('alcohol');
        const dr = [];
        if (w.some(Boolean)) dr.push(`water ${avg(w).toFixed(1)} glasses a day`);
        if (c.length) dr.push(`coffee ${avg(c).toFixed(1)} cups a day`);
        if (a.length) dr.push(`alcohol ${(a.reduce((s, x) => s + x, 0) / a.length * 7).toFixed(1)} drinks a week`);
        if (dr.length) out.push(`- Drinks (average on logged days): ${dr.join(', ')}`);
        const regular = lines(p.medications);
        const withMeds = logged.filter(d => d.log.meds && Object.keys(d.log.meds.taken || {}).length);
        regular.forEach(m => {
          if (withMeds.length) out.push(`- ${T(m)}: taken on ${withMeds.filter(d => d.log.meds.taken[m]).length} of ${withMeds.length} logged days`);
        });
        const extra = {};
        logged.forEach(d => ((d.log.meds && d.log.meds.extra) || []).forEach(x => { if (x.name) extra[x.name] = (extra[x.name] || 0) + 1; }));
        const ex = Object.entries(extra);
        if (ex.length) out.push(`- Other medication taken: ${ex.map(([n, k]) => `${T(n)} (${k}×)`).join(', ')}`);
      }
      out.push('');
    }

    // ----- Body measurements: the period, plus the last value before it as a baseline.
    if (inc.body) {
      const inPeriod = (list) => {
        const before = list.filter(m => m.date < o.from);
        return [...before.slice(-1), ...list.filter(m => m.date >= o.from && m.date <= o.to)];
      };
      const w = inPeriod(data.weights), bp = inPeriod(data.bp);
      const temp = data.temps.filter(m => m.date >= o.from && m.date <= o.to);
      if (w.length || bp.length || temp.length) out.push('## Body measurements', '');
      if (w.length) {
        out.push('| Date | Weight (kg) | BMI |', '|---|---|---|');
        w.forEach(m => out.push(`| ${D(m.date)} | ${m.value} | ${bmiOf(m.value, p.heightCm) ?? '–'} |`));
        out.push('');
      }
      if (bp.length) {
        out.push('| Date | Blood pressure (mmHg) | Pulse (bpm) |', '|---|---|---|');
        bp.forEach(m => out.push(`| ${D(m.date)} | ${m.value.sys}/${m.value.dia} | ${m.value.pulse ?? '–'} |`));
        out.push('');
      }
      if (temp.length) {
        out.push('| Date | Time | Temperature (°C) |', '|---|---|---|');
        temp.forEach(m => out.push(`| ${D(m.date)} | ${m.time || '–'} | ${Number(m.value).toFixed(1)} |`));
        out.push('');
      }
    }

    // ----- Medical documents (all selected documents, also older ones)
    if (inc.docs && data.documents.length) {
      out.push('## Medical documents', '');
      [...data.documents].sort((a, b) => b.date.localeCompare(a.date)).forEach(doc => {
        out.push(`### ${D(doc.date)} · ${T(doc.title)}`, '');
        out.push(`- Source: ${llm ? doc.category : doc.correspondent || doc.category}`, '');
        out.push('```text', T(doc.content).replace(/```/g, "'''"), '```', '');
      });
    }

    // ----- Daily log, oldest first
    if (inc.log || inc.health) {
      const rows = days.filter(d => (inc.log && d.log && hasContent(d.log)) || (inc.health && d.health));
      if (rows.length) out.push('## Daily log', '');
      rows.forEach(d => {
        out.push(`### ${D(d.date)} · ${Dates.weekday(d.date)}`);
        const h = d.health;
        if (inc.health && h) {
          if (h.sleep && h.sleep.total) {
            const s = h.sleep, parts = [];
            if (s.bed && s.wake) parts.push(`bed ${s.bed}, up ${s.wake}`);
            if (s.deep != null) parts.push(`deep ${fmtMin(s.deep)}, REM ${fmtMin(s.rem)}, awake ${Math.round(s.awake || 0)} min`);
            out.push(`- Sleep (night before): ${fmtMin(s.total)}${parts.length ? ` (${parts.join('; ')})` : ''}`);
          }
          const m = [];
          if (h.steps) m.push(`Steps ${num(h.steps)}`);
          if (h.restingHr) m.push(`Resting HR ${h.restingHr} bpm`);
          if (h.hrv) m.push(`HRV ${h.hrv} ms`);
          if (m.length) out.push(`- ${m.join(' · ')}`);
          if (h.workouts && h.workouts.length) out.push(`- Workouts: ${h.workouts.map(wk => `${wk.type} ${wk.minutes} min${wk.start ? ` (${wk.start})` : ''}`).join(', ')}`);
        }
        const l = d.log;
        if (inc.log && l) {
          // Meals in time order. A meal without a time keeps a typical time for sorting.
          const meals = [['Breakfast', l.meals.breakfast, '08:00'], ['Lunch', l.meals.lunch, '12:30'],
            ...(l.snacks || []).map(s => ['Snack', s, '16:00']), ['Dinner', l.meals.dinner, '20:00']]
            .filter(([, x]) => x && x.text)
            .sort((a, b) => (a[1].time || a[2]).localeCompare(b[1].time || b[2]));
          meals.forEach(([label, x]) => out.push(`- ${label}${x.time ? ` (${x.time})` : ''}: ${T(x.text)}`));
          const dk = l.drinks || {};
          if (dk.water || dk.coffee || dk.alcohol) {
            out.push(`- Drinks: water ${dk.water || 0} glasses, coffee ${dk.coffee || 0} cups, alcohol ${dk.alcohol || 0} drinks`);
          }
          const md = l.meds || {};
          const meds = [...Object.entries(md.taken || {}).map(([n, ok]) => `${T(n)} (${ok ? 'taken' : 'not taken'})`),
            ...(md.extra || []).filter(x => x.name).map(x => `${T(x.name)}${x.time ? ` at ${x.time}` : ''}`)];
          if (meds.length) out.push(`- Medication: ${meds.join('; ')}`);
          if (l.activities) out.push(`- Activities: ${T(l.activities)}`);
          if (l.symptoms && l.symptoms.length) {
            out.push(`- Symptoms: ${l.symptoms.map(s => `${T(s.name)} (${[SEV[s.severity || 1], describeWhen(s)].filter(Boolean).join(', ')})`).join('; ')}`);
          }
          if (l.notes) out.push(`- Notes: ${T(l.notes)}`);
        }
        if (inc.body) {
          const ms = data.measurements.filter(m => m.date === d.date).map(m => `${MLABEL[m.type](m.value)}${m.time ? ` (${m.time})` : ''}`);
          if (ms.length) out.push(`- Measured: ${ms.join('; ')}`);
        }
        out.push('');
      });
    }

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function hasContent(l) {
    const dk = l.drinks || {}, md = l.meds || {};
    return !!(l.activities || l.notes || (l.symptoms && l.symptoms.length) || (l.snacks && l.snacks.length) ||
      dk.water || dk.coffee || dk.alcohol || Object.values(md.taken || {}).some(Boolean) || (md.extra && md.extra.length) ||
      ['breakfast', 'lunch', 'dinner'].some(k => l.meals && l.meals[k] && l.meals[k].text));
  }

  window.Report = { buildReport, makeRedactor, hasContent, bmiOf, SEV, MLABEL, describeWhen };
})();
