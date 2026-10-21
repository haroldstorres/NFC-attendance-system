// Sends phone notifications to parents (Firebase Cloud Messaging).
// Deploy with: firebase deploy --only functions   (needs the Blaze plan)
const {onDocumentCreated} = require('firebase-functions/v2/firestore');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');

initializeApp();

const TZ = 'Asia/Manila';
const clock = t => new Date(t).toLocaleTimeString('en-PH', {hour: 'numeric', minute: '2-digit', timeZone: TZ});

// pref is one of: in, out, absent (the toggles in the parent app)
async function pushTo(emails, pref, title, body, tag) {
  const db = getFirestore();
  const list = [...new Set((emails || []).map(e => String(e).toLowerCase()))];
  const tokens = [];
  for (let i = 0; i < list.length; i += 30) {
    const snap = await db.collection('pushTokens').where('email', 'in', list.slice(i, i + 30)).get();
    snap.forEach(d => { const p = d.get('prefs') || {}; if (p[pref] !== false) tokens.push(d.id); });
  }
  if (!tokens.length) return;
  const res = await getMessaging().sendEach(tokens.map(token => ({
    token,
    data: {title, body, tag},
    webpush: {headers: {Urgency: 'high'}}
  })));
  // Remove tokens that are no longer valid.
  const dead = [];
  res.responses.forEach((r, i) => {
    const code = (r.error && r.error.code) || '';
    if (!r.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) dead.push(tokens[i]);
  });
  await Promise.all(dead.map(t => db.collection('pushTokens').doc(t).delete()));
}

// A child taps in or out
exports.notifyTap = onDocumentCreated('log/{id}', async event => {
  const l = event.data && event.data.data();
  if (!l || !l.parentEmails || !l.parentEmails.length) return;
  const name = l.name || 'Your child';
  const t = clock(l.time);
  const m = {
    in: ['in', `${name} arrived at school`, `Tap-in at ${t}`],
    out: ['out', `${name} has left school`, `Tap-out at ${t}`],
    lunch: ['out', `${name} left school for lunch`, `Out at ${t}`],
    back: ['in', `${name} is back from lunch`, `Back at ${t}`]
  }[l.type];
  if (!m) return;
  await pushTo(l.parentEmails, m[0], m[1], m[2], 'tap-' + event.params.id);
});

// A teacher notifies parents that the child has not arrived
exports.notifyAlert = onDocumentCreated('alerts/{id}', async event => {
  const a = event.data && event.data.data();
  if (!a || !a.parentEmails || !a.parentEmails.length) return;
  const name = a.name || 'Your child';
  await pushTo(a.parentEmails, 'absent', `${name} has not arrived at school`,
    'No tap-in has been recorded yet today. If your child will be absent, please let the teacher know.', 'alert-' + event.params.id);
});
