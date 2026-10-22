// Sends phone notifications to parents (Firebase Cloud Messaging).
// Deploy with: firebase deploy --only functions   (needs the Blaze plan)
const {onDocumentCreated, onDocumentUpdated} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
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

// ---------------------------------------------------------------------------------------------
// Automatic "has not arrived" notice. Runs every 10 minutes on school mornings and acts once a day,
// 60 minutes after the "Late after" time (default 07:30, so 08:30). It sends the same push and writes the same
// alert record a teacher would (id kidId_day_absent), so the teacher's screen shows it as already sent.
// It does nothing when: the day is a holiday (Manage > School > Holidays), the child already has a tap today,
// the parent already sent an absence note, a notice was already sent, or too few children have tapped in
// (which usually means school is not in session, for example a typhoon suspension that was not entered).
// ---------------------------------------------------------------------------------------------
const AUTO_AFTER_MIN = 60;
const MIN_IN_SHARE = 0.10;
const MIN_IN_COUNT = 3;

function manilaNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false}).formatToParts(now).map(x => [x.type, x.value]));
  const h = +p.hour % 24;
  return {iso: `${p.year}-${p.month}-${p.day}`, ds: `${+p.year}-${+p.month}-${+p.day}`, minutes: h * 60 + +p.minute,
    start: Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00+08:00`)};
}

exports.autoNotArrived = onSchedule({schedule: '*/10 6-11 * * 1-5', timeZone: TZ}, async () => {
  const db = getFirestore();
  const t = manilaNow();
  const school = (await db.doc('settings/school').get()).data() || {};
  const m = /^(\d\d):(\d\d)$/.exec(school.lateAfter || '07:30') || [null, '07', '30'];
  const target = +m[1] * 60 + +m[2] + AUTO_AFTER_MIN;
  if (t.minutes < target || t.minutes >= target + 30) return;

  const marker = db.doc('autoAlerts/' + t.iso);
  if ((await marker.get()).exists) return;
  if ((await db.doc('holidays/' + t.iso).get()).exists) { await marker.set({skipped: 'holiday', time: Date.now()}); return; }

  const kids = (await db.collection('kids').get()).docs;
  const taps = (await db.collection('log').where('time', '>=', t.start).get()).docs.map(d => d.data());
  const arrived = new Set(taps.filter(l => l.type === 'in' || l.type === 'back').map(l => l.kidId));
  const seen = new Set(taps.map(l => l.kidId));
  if (arrived.size < Math.max(MIN_IN_COUNT, Math.ceil(kids.length * MIN_IN_SHARE))) return; // not enough taps yet: try again next run

  const notes = new Set((await db.collection('absenceNotes').where('day', '==', t.ds).get()).docs.map(d => d.get('kidId')));
  let sent = 0;
  for (const k of kids) {
    const kd = k.data(), emails = kd.parentEmails || [];
    if (!emails.length || seen.has(k.id) || notes.has(k.id)) continue;
    const ref = db.doc(`alerts/${k.id}_${t.ds}_absent`);
    if ((await ref.get()).exists) continue;
    await ref.set({kidId: k.id, name: kd.name || '', section: kd.section || '', parentEmails: emails.slice(0, 6), type: 'absent',
      day: t.ds, time: Date.now(), by: 'auto'});
    // The push itself is sent by notifyAlert, which fires when the alert record is created.
    sent++;
  }
  await marker.set({sent, time: Date.now()});
  console.log('autoNotArrived', t.iso, 'sent', sent);
});

// ---------------------------------------------------------------------------------------------
// Weekly Firestore backup into a Cloud Storage bucket (Sundays 02:00).
// Setup: create a bucket, set BACKUP_BUCKET, give the function's service account the roles described in README-setup.txt.
// ---------------------------------------------------------------------------------------------
exports.weeklyBackup = onSchedule({schedule: '0 2 * * 0', timeZone: TZ, timeoutSeconds: 540}, async () => {
  const bucket = process.env.BACKUP_BUCKET;
  if (!bucket) { console.error('BACKUP_BUCKET is not set; backup skipped'); return; }
  const firestore = require('@google-cloud/firestore');
  const client = new firestore.v1.FirestoreAdminClient();
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  const stamp = manilaNow().iso;
  const [op] = await client.exportDocuments({
    name: client.databasePath(project, '(default)'),
    outputUriPrefix: `gs://${bucket}/firestore-backups/${stamp}`,
    collectionIds: []   // empty = every collection
  });
  console.log('Backup started', op.name, '->', `gs://${bucket}/firestore-backups/${stamp}`);
});

// ---------------------------------------------------------------------------------------------
// Tell the parent when the school answers something they sent (pref "msg": on unless the parent turned it off).
// ---------------------------------------------------------------------------------------------
const withNote = (text, note) => note ? `${text} Note: ${String(note).slice(0, 120)}` : text;

exports.notifyRequestAnswered = onDocumentUpdated('changeRequests/{id}', async event => {
  const b = event.data.before.data(), a = event.data.after.data();
  if (!a || !b || b.status === a.status || !['done', 'declined'].includes(a.status) || !a.parentEmail) return;
  const name = a.kidName || 'your child';
  await pushTo([a.parentEmail], 'msg',
    a.status === 'done' ? `Change for ${name} was done` : `Change for ${name} was declined`,
    withNote(a.status === 'done' ? 'The school made the change you asked for.' : 'The school could not make the change you asked for.', a.note),
    'req-' + event.params.id);
});

exports.notifyReportAnswered = onDocumentUpdated('childReports/{id}', async event => {
  const b = event.data.before.data(), a = event.data.after.data();
  if (!a || !b || b.status === a.status || !['at_school', 'not_at_school'].includes(a.status) || !a.parentEmail) return;
  const name = a.kidName || 'Your child';
  await pushTo([a.parentEmail], 'msg',
    a.status === 'at_school' ? `${name} is confirmed at school` : `The school confirmed ${name} is not at school`,
    withNote(a.status === 'at_school' ? 'The teacher checked your report and your child is at school.' : 'The school has noted your report.', a.note),
    'rep-' + event.params.id);
});
