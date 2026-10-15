// Three-way merge of the profile, for saves that meet a newer version from another device.
// base: the server copy the local edits started from. mine: the local copy. theirs: the newer server copy.
// Rule: take the server copy, then apply again only what changed here since base.
// Medications merge one by one, by id. No DOM. Unit-tested in tests/profile.test.js.

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function mergeMeds(base = [], mine = [], theirs = []) {
  const byId = list => new Map(list.map(m => [m.id, m]));
  const b = byId(base), m = byId(mine), t = byId(theirs);
  const out = [];
  for (const their of theirs) {
    const id = their.id;
    if (m.has(id)) {
      // Both have it: my version wins only when I changed it.
      out.push(b.has(id) && same(m.get(id), b.get(id)) ? their : m.get(id));
    } else if (!b.has(id)) {
      out.push(their); // added on the other device
    } else if (!same(their, b.get(id))) {
      out.push(their); // I deleted it, but the other device changed it: keep their change
    } // else: I deleted it and nobody changed it: it stays deleted
  }
  for (const mineMed of mine) {
    const id = mineMed.id;
    if (t.has(id)) continue;
    if (!b.has(id)) out.push(mineMed); // added here
    else if (!same(mineMed, b.get(id))) out.push(mineMed); // deleted there, but changed here: keep mine
  }
  return out;
}

/** Returns the merged profile. Missing base (no shared start): mine wins for every field. */
export function mergeProfile(base, mine, theirs) {
  const b = base || {}, m = mine || {}, t = theirs || {};
  const out = { ...t };
  for (const key of new Set([...Object.keys(m), ...Object.keys(b)])) {
    if (key === 'medications') continue;
    if (!base || !same(m[key], b[key])) {
      if (key in m) out[key] = m[key]; else delete out[key];
    }
  }
  out.medications = base ? mergeMeds(b.medications, m.medications, t.medications) : (m.medications || t.medications || []);
  return out;
}
