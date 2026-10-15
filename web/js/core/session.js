// Who is logged in on this page. Per-user browser storage (unsaved edits) is keyed by this id,
// so a second user on the same device never sees or sends the first user's edits.
let uid = null;
export const session = {
  get uid() { return uid; },
  set(user) { uid = user ? user.id : null; },
};
