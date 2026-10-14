// Data layer. Both classes have the same methods.
// - MockApi keeps sample data in this browser (demo, no server).
// - HttpApi talks to the server on the NAS.
// The server sets window.DIARY_CONFIG = { api: '/api' } before this file loads.
(function () {
  const { Dates, pad, rng, minToHm, emptyLog } = U;
  const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));

  // ---------- Sample data ----------

  const BREAKFASTS = ['Oatmeal with banana, coffee', 'Two eggs, wholemeal toast, coffee', 'Greek yogurt, granola, orange juice',
    'Croissant and coffee', 'Skipped, coffee only', 'Porridge with berries, green tea'];
  const LUNCHES = ['Chicken salad, bread', 'Pasta bolognese', 'Sandwich (tuna), apple', 'Rice, salmon, broccoli',
    'Couscous with vegetables', 'Burger and fries (work lunch)', 'Lentil soup, bread, cheese'];
  const SNACKS = ['Apple', 'Handful of almonds', 'Coffee and a biscuit', 'Banana', 'Dark chocolate, 2 squares', 'Yogurt'];
  const DINNERS = ['Grilled fish, potatoes, salad', 'Pizza', 'Chicken curry with rice', 'Omelette, salad',
    'Steak, green beans', 'Vegetable stir-fry with noodles', 'Soup and bread', 'Leftover pasta'];
  const ACTIVITIES = ['Office day. Walked 20 min at lunch.', 'Remote work. Gym in the evening: 45 min weights.',
    'Football with friends, 1 h.', 'Long walk, about 9 km.', 'Mostly sitting, busy with deadlines.',
    'Cycled to work and back, 2 × 25 min.', 'Errands in town, a lot of walking.', 'Rest day at home.'];
  const WORKOUTS = [{ type: 'Strength training', minutes: 45, start: '18:30' }, { type: 'Walking', minutes: 52, start: '12:40' },
    { type: 'Cycling', minutes: 28, start: '08:10' }, { type: 'Soccer', minutes: 64, start: '19:15' }, { type: 'Running', minutes: 31, start: '07:05' }];
  const REGULAR_MED = 'Magnesium 300 mg, evening';
  const NOTES = ['Two coffees before noon.', 'Late screen time, went to bed later than planned.', 'Busy, stressful day.',
    'Drank about 2 L of water.', 'Glass of wine with dinner.'];

  function seed() {
    const r = rng(7);
    const pick = a => a[Math.floor(r() * a.length)];
    const between = (a, b) => a + r() * (b - a);
    const t5 = (a, b) => minToHm(Math.round(between(a, b) / 5) * 5);
    const today = Dates.today();

    const profile = {
      name: 'Alex Example',
      dob: '1991-03-14',
      sex: 'Male',
      ethnicity: 'Southern European',
      heightCm: 178,
      conditions: 'Mild mitral valve prolapse (diagnosed 2024)\nIsolated PVCs (benign, Holter 2026)',
      medications: REGULAR_MED,
      allergies: 'Penicillin (rash)',
      surgeries: 'Appendectomy (2009)',
      familyHistory: 'Father: high blood pressure, type 2 diabetes\nMother: hypothyroidism',
      lifestyle: 'Non-smoker. Coffee 2–3 cups a day. Alcohol 2–4 glasses a week.',
    };

    const days = {}, health = {};
    for (let i = 75; i >= 0; i--) {
      const date = Dates.add(today, -i);
      let sleepTotal = null;
      // Today has no health data yet: the shortcut has not run.
      if (i > 0) {
        sleepTotal = Math.round(between(330, 490));
        const deep = Math.round(sleepTotal * between(0.12, 0.2));
        const rem = Math.round(sleepTotal * between(0.18, 0.26));
        const awake = Math.round(between(8, 45));
        const bed = Math.round(between(22 * 60 + 30, 24 * 60 + 50) / 5) * 5;
        health[date] = {
          sleep: { total: sleepTotal, deep, rem, core: sleepTotal - deep - rem, awake, bed: minToHm(bed), wake: minToHm(bed + sleepTotal + awake) },
          steps: Math.round(between(2800, 14500)),
          restingHr: Math.round(between(54, 66)),
          hrv: Math.round(between(30, 62)),
          workouts: r() < 0.35 ? [pick(WORKOUTS)] : [],
          source: 'apple',
          syncedAt: `${Dates.add(date, 1)}T08:${pad(Math.floor(between(0, 59)))}`,
          edited: [],
        };
      }
      if (i === 0) {
        days[date] = {
          ...emptyLog(),
          meals: { breakfast: { time: '07:40', text: 'Oatmeal with banana, coffee' }, lunch: { time: '', text: '' }, dinner: { time: '', text: '' } },
          drinks: { water: 1, coffee: 1, alcohol: 0 },
        };
        continue;
      }
      if (r() > 0.86) continue; // Some days are not logged.

      const weekend = [0, 6].includes(Dates.parse(date).getDay());
      const coffee = Math.round(between(1, 4.4));
      const symptoms = [];
      const sev = () => (r() < 0.6 ? 1 : r() < 0.8 ? 2 : 3);
      if (sleepTotal < 380 && r() < 0.6) symptoms.push({ name: 'Fatigue', severity: sev(), when: 'periods', periods: r() < 0.5 ? ['afternoon'] : ['afternoon', 'evening'] });
      const headache = r() < 0.1;
      if (headache) symptoms.push(r() < 0.4 ? { name: 'Headache', severity: sev(), when: 'day' } : { name: 'Headache', severity: sev(), when: 'periods', periods: ['afternoon'] });
      const palp = coffee >= 3 && r() < 0.25;
      if (palp) { const from = t5(14 * 60 + 30, 16 * 60); symptoms.push({ name: 'Palpitations', severity: 2, when: 'time', from, to: minToHm(U.hmToMin(from) + 10) }); }
      if (r() < 0.06) symptoms.push({ name: 'Bloating', severity: 1, when: 'periods', periods: ['evening'] });
      const snacks = [];
      if (r() < 0.4) snacks.push({ time: t5(10 * 60 + 15, 11 * 60), text: pick(SNACKS) });
      if (r() < 0.55) snacks.push({ time: t5(16 * 60, 17 * 60 + 30), text: pick(SNACKS) });
      let notes = '';
      if (palp) notes = `Palpitations for about 10 min, after coffee number ${coffee}.`;
      else if (symptoms.some(s => s.name === 'Fatigue')) notes = 'Tired all afternoon.';
      else if (r() < 0.15) notes = pick(NOTES);

      days[date] = {
        meals: {
          breakfast: { time: t5(7 * 60, 8 * 60 + 30), text: pick(BREAKFASTS) },
          lunch: { time: t5(12 * 60 + 15, 13 * 60 + 30), text: pick(LUNCHES) },
          dinner: { time: t5(19 * 60 + 15, 21 * 60), text: pick(DINNERS) },
        },
        snacks,
        drinks: { water: Math.round(between(3, 9)), coffee, alcohol: weekend && r() < 0.6 ? Math.round(between(1, 3)) : 0 },
        meds: { taken: { [REGULAR_MED]: r() < 0.85 }, extra: headache && r() < 0.6 ? [{ name: 'Paracetamol 1 g', time: t5(15 * 60, 18 * 60) }] : [] },
        activities: pick(ACTIVITIES), symptoms, notes,
      };
    }

    const measurements = [];
    let id = 1;
    [-118, -96, -81, -60, -47, -33, -19, -9, -3].forEach((d, k, all) => {
      const value = Math.round((78.6 - (1.7 * k) / (all.length - 1) + between(-0.3, 0.3)) * 10) / 10;
      measurements.push({ id: id++, type: 'weight', date: Dates.add(today, d), time: '07:30', value, source: k % 3 === 1 ? 'manual' : 'apple' });
    });
    [[-110, 128, 82, 64], [-60, 124, 79, 61], [-20, 121, 78, 60], [-5, 142, 91, 66]].forEach(([d, sys, dia, pulse]) => {
      measurements.push({ id: id++, type: 'bp', date: Dates.add(today, d), time: '19:00', value: { sys, dia, pulse }, source: 'manual' });
    });
    [[-41, '21:10', 38.3], [-40, '08:00', 37.6], [-40, '20:30', 37.9], [-39, '08:15', 37.0]].forEach(([d, time, value]) => {
      measurements.push({ id: id++, type: 'temp', date: Dates.add(today, d), time, value, source: 'manual' });
    });

    const dmy = n => { const d = Dates.parse(Dates.add(today, n)); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
    const documents = [
      {
        id: 101, date: Dates.add(today, -27), title: 'Blood test – follow-up', category: 'Blood test',
        correspondent: 'Laboratoire BioCentre', url: '#',
        content: `LABORATOIRE BIOCENTRE – Sample no. 2026-88412-07\nPatient: Alex Example – born 14/03/1991\nCollected: ${dmy(-27)} 08:10, fasting\n\nTotal cholesterol   1.98 g/L    (< 2.00)\nLDL cholesterol     1.30 g/L    (< 1.60)\nHDL cholesterol     0.55 g/L    (> 0.40)\nTriglycerides       0.96 g/L    (< 1.50)\nVitamin D (25-OH)   31 ng/mL    (30 – 100)\nMagnesium           0.86 mmol/L (0.70 – 1.00)\nPotassium           4.2 mmol/L  (3.5 – 5.0)\n\nValidated by Dr. Claire Martin, biologist.`,
      },
      {
        id: 102, date: Dates.add(today, -128), title: 'Holter ECG, 24 h', category: 'Cardiology',
        correspondent: 'Dr. Laurent Petit – Cardiology', url: '#',
        content: `24-HOUR HOLTER ECG\nPatient: Alex Example, DOB 14/03/1991, file 4481920377\nRecording started ${dmy(-129)} 09:30\n\nSinus rhythm throughout. Mean HR 72 bpm, min 48 bpm (sleep), max 141 bpm (exercise).\n312 isolated PVCs (< 1% of beats), no couplets, no runs.\nNo pauses > 2 s. No atrial fibrillation.\nPatient diary: palpitations at 15:20 match an isolated PVC.\n\nConclusion: benign isolated PVCs. No treatment needed. Reduce caffeine.\nDr. L. Petit – tel. 01 23 45 67 89 – l.petit@clinique-saint-roch.fr`,
      },
      {
        id: 103, date: Dates.add(today, -142), title: 'Echocardiogram report', category: 'Cardiology',
        correspondent: 'Dr. Laurent Petit – Cardiology', url: '#',
        content: `TRANSTHORACIC ECHOCARDIOGRAM – Clinique Saint-Roch\nPatient: Alex Example, DOB 14/03/1991, ID 4481920377\nIndication: palpitations, soft systolic murmur.\n\nLeft ventricle: normal size and wall thickness. LVEF 62% (Simpson biplane).\nMitral valve: mild prolapse of the posterior leaflet, trace regurgitation.\nAortic valve: tricuspid, normal. Right heart normal. No pericardial effusion.\n\nConclusion: mild mitral valve prolapse with trace regurgitation. Normal LV function.\nFollow-up echo in 2 years, or earlier if symptoms change.\nDr. Laurent Petit, cardiologist.`,
      },
      {
        id: 104, date: Dates.add(today, -205), title: 'Blood test – annual check-up', category: 'Blood test',
        correspondent: 'Laboratoire BioCentre', url: '#',
        content: `LABORATOIRE BIOCENTRE – Sample no. 2026-31877-02\nPatient: Alex Example – born 14/03/1991\nCollected: ${dmy(-205)} 07:55, fasting\n\nTotal cholesterol   2.15 g/L    (< 2.00)    HIGH\nLDL cholesterol     1.42 g/L    (< 1.60)\nHDL cholesterol     0.52 g/L    (> 0.40)\nTriglycerides       1.05 g/L    (< 1.50)\nFasting glucose     0.94 g/L    (0.70 – 1.00)\nHbA1c               5.3 %       (< 5.7)\nTSH                 2.1 mIU/L   (0.4 – 4.0)\nFerritin            38 µg/L     (30 – 400)\nVitamin D (25-OH)   18 ng/mL    (30 – 100)  LOW\nCreatinine          9.8 mg/L    (7 – 12), eGFR > 90\n\nValidated by Dr. Claire Martin, biologist.`,
      },
    ];

    // The shortcut last ran yesterday morning. Today's data has not arrived yet.
    const settings = {
      lastSync: health[Dates.add(today, -2)].syncedAt,
      redactWords: ['BioCentre', 'Clinique Saint-Roch', 'Saint-Roch'],
      excludedDocs: [],
    };

    return { profile, days, health, measurements, documents, settings, nextId: id, seededOn: today };
  }

  // ---------- Mock (browser only) ----------

  const KEY = 'health-diary-demo-v3';

  class MockApi {
    constructor() {
      this.isMock = true;
      let db = null;
      try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* storage blocked */ }
      // Re-seed when the stored demo is from an earlier day, so dates stay recent.
      this.db = db && db.seededOn === Dates.today() ? db : seed();
      this.persist();
    }
    persist() { try { localStorage.setItem(KEY, JSON.stringify(this.db)); } catch (e) { /* storage blocked */ } }

    async getProfile() { return clone(this.db.profile); }
    async saveProfile(p) { this.db.profile = clone(p); this.persist(); }

    async getDay(date) { return { date, log: clone(this.db.days[date] || null), health: clone(this.db.health[date] || null) }; }
    async saveLog(date, log) { this.db.days[date] = clone(log); this.persist(); }
    async saveHealth(date, h) { this.db.health[date] = clone(h); this.persist(); }
    async listDays(from, to) {
      const dates = new Set([...Object.keys(this.db.days), ...Object.keys(this.db.health)]);
      return [...dates].filter(d => (!from || d >= from) && (!to || d <= to)).sort()
        .map(d => ({ date: d, log: clone(this.db.days[d] || null), health: clone(this.db.health[d] || null) }));
    }

    async listMeasurements(type) {
      return clone(this.db.measurements.filter(m => !type || m.type === type)
        .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))));
    }
    async addMeasurement(m) { const row = { ...clone(m), id: this.db.nextId++ }; this.db.measurements.push(row); this.persist(); return row; }
    async deleteMeasurement(id) { this.db.measurements = this.db.measurements.filter(m => m.id !== id); this.persist(); }

    async listDocuments() { return clone(this.db.documents); }

    async getSettings() { return clone(this.db.settings); }
    async saveSettings(s) { this.db.settings = { ...this.db.settings, ...clone(s) }; this.persist(); }

    // Does what the iPhone shortcut will do: send last night's sleep and today's numbers so far.
    // Values corrected by hand ("edited") are kept.
    async simulateSync() {
      const today = Dates.today();
      const now = new Date();
      const stamp = `${today}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const minutes = now.getHours() * 60 + now.getMinutes();
      const old = this.db.health[today] || { edited: [] };
      const fresh = {
        sleep: { total: 412, deep: 64, rem: 95, core: 253, awake: 21, bed: '23:35', wake: '06:28' },
        steps: Math.max(old.steps || 0, Math.round(Math.max(0, minutes - 390) * 9.5) + 140),
        restingHr: 58, hrv: 47,
        workouts: minutes > 12 * 60 + 40 ? [{ type: 'Walking', minutes: 24, start: '12:15' }] : [],
      };
      const edited = old.edited || [];
      for (const k of edited) fresh[k] = old[k];
      this.db.health[today] = { ...fresh, source: 'apple', syncedAt: stamp, edited };
      this.db.settings.lastSync = stamp;
      this.persist();
    }
    async resetDemo() { this.db = seed(); this.persist(); }
  }

  // ---------- Real server ----------

  class HttpApi {
    constructor(base) { this.base = base; this.isMock = false; }
    async req(path, opts = {}) {
      const res = await fetch(this.base + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Session expired or logged out on another device: the app shows the login screen.
        if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('diary:logged-out'));
        const err = new Error(body.detail || `The server answered ${res.status} for ${path}.`);
        err.status = res.status;
        throw err;
      }
      return res.status === 204 ? null : res.json();
    }
    put(path, body) { return this.req(path, { method: 'PUT', body: JSON.stringify(body) }); }

    getProfile() { return this.req('/profile'); }
    saveProfile(p) { return this.put('/profile', p); }
    getDay(date) { return this.req(`/days/${date}`); }
    saveLog(date, log) { return this.put(`/days/${date}/log`, log); }
    saveHealth(date, h) { return this.put(`/days/${date}/health`, h); }
    listDays(from, to) { return this.req(`/days?from=${from || ''}&to=${to || ''}`); }
    listMeasurements(type) { return this.req(`/measurements?type=${type || ''}`); }
    addMeasurement(m) { return this.req('/measurements', { method: 'POST', body: JSON.stringify(m) }); }
    deleteMeasurement(id) { return this.req(`/measurements/${id}`, { method: 'DELETE' }); }
    listDocuments() { return this.req('/documents'); }
    getSettings() { return this.req('/settings'); }
    saveSettings(s) { return this.put('/settings', s); }
    post(path, body) { return this.req(path, { method: 'POST', body: JSON.stringify(body || {}) }); }
    del(path) { return this.req(path, { method: 'DELETE' }); }

    // Accounts
    authStatus() { return this.req('/auth/status'); }
    setup(code, username, password) { return this.post('/auth/setup', { code, username, password }); }
    login(username, password) { return this.post('/auth/login', { username, password }); }
    logout() { return this.post('/auth/logout'); }
    changePassword(current, next) { return this.put('/me/password', { current, new: next }); }
    createIngestToken() { return this.post('/me/ingest-token'); }
    revokeIngestToken() { return this.del('/me/ingest-token'); }
    getPaperless() { return this.req('/me/paperless'); }
    savePaperless(cfg) { return this.put('/me/paperless', cfg); }
    refreshDocuments() { return this.req('/documents?refresh=true'); }
    listUsers() { return this.req('/users'); }
    createUser(u) { return this.post('/users', u); }
    resetPassword(id, password) { return this.put(`/users/${id}/password`, { password }); }
    deleteUser(id) { return this.del(`/users/${id}`); }

    async importAppleHealth(file) {
      const fd = new FormData();
      fd.append('file', file);
      return this.req('/import/apple-health', { method: 'POST', body: fd, headers: {} });
    }
  }

  const cfg = window.DIARY_CONFIG || {};
  window.Api = cfg.api ? new HttpApi(cfg.api) : new MockApi();
})();
