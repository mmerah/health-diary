// Small helpers shared by the data layer, the report builder and the app.
(function () {
  const pad = n => String(n).padStart(2, '0');

  // All dates are local calendar days as 'YYYY-MM-DD' strings.
  const Dates = {
    iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; },
    parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); },
    today() { return Dates.iso(new Date()); },
    add(s, n) { const d = Dates.parse(s); d.setDate(d.getDate() + n); return Dates.iso(d); },
    // Number of days from b to a (a - b).
    diff(a, b) { return Math.round((Dates.parse(a) - Dates.parse(b)) / 86400000); },
    label(s, opts) {
      return Dates.parse(s).toLocaleDateString('en-GB', opts || { weekday: 'short', day: 'numeric', month: 'short' });
    },
    weekday(s) { return Dates.parse(s).toLocaleDateString('en-GB', { weekday: 'short' }); },
    age(dob, at) {
      const b = Dates.parse(dob), t = Dates.parse(at);
      let a = t.getFullYear() - b.getFullYear();
      if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) a--;
      return a;
    },
  };

  // 425 -> "7h05"
  function fmtMin(m) {
    if (m == null || isNaN(m)) return '–';
    m = Math.round(m);
    return `${Math.floor(m / 60)}h${pad(m % 60)}`;
  }

  // "23:40" -> 1420
  function hmToMin(s) {
    if (!s) return null;
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  }
  function minToHm(m) { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Seeded random numbers, so the demo data is the same on every load.
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const num = n => Number(n).toLocaleString('en-US');

  const PERIODS = ['morning', 'afternoon', 'evening', 'night'];
  // Period of the day for a time: night before 06:00 and from 22:00.
  function periodOf(hm) {
    const m = hmToMin(hm);
    if (m == null) return null;
    return m < 360 ? 'night' : m < 720 ? 'morning' : m < 1080 ? 'afternoon' : m < 1320 ? 'evening' : 'night';
  }

  // An empty diary entry for one day.
  function emptyLog() {
    return {
      meals: { breakfast: { time: '', text: '' }, lunch: { time: '', text: '' }, dinner: { time: '', text: '' } },
      snacks: [],
      drinks: { water: 0, coffee: 0, alcohol: 0 },
      meds: { taken: {}, extra: [] },
      activities: '',
      // { name, severity: 1 mild | 2 moderate | 3 severe,
      //   when: 'day' | 'periods' | 'time' | null, periods: ['morning', …], from: 'HH:MM', to: 'HH:MM' }
      symptoms: [],
      notes: '',
    };
  }

  window.U = { pad, Dates, fmtMin, hmToMin, minToHm, esc, rng, num, emptyLog, PERIODS, periodOf };
})();
