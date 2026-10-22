// Security-rules tests. Run with:  npm run test:rules   (starts the Firestore emulator for you; needs Java 11+)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const {doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, collection, query, where} = require('firebase/firestore');

let env;
const now = () => Date.now();
const HOUR = 3600e3, DAY = 24 * HOUR;
const tap = (extra = {}) => ({kidId: 'k1', name: 'Kid One', time: now(), type: 'in', parentEmails: ['p@x.com'], section: 'Grade 1 - A', ...extra});

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-tapin',
    firestore: {rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8')}
  });
});
test.after(async () => { await env.cleanup(); });
test.beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'staff/admin'), {role: 'admin', email: 'a@x.com', name: 'Admin'});
    await setDoc(doc(db, 'staff/gate'), {role: 'gate', email: 'g@x.com', name: 'Gate'});
    await setDoc(doc(db, 'staff/head'), {role: 'head', email: 'h@x.com', name: 'Head'});
    await setDoc(doc(db, 'staff/tv'), {role: 'display', email: 't@x.com', name: 'TV'});
    await setDoc(doc(db, 'staff/adv1'), {role: 'adviser', email: 'v1@x.com', name: 'Adv 1', sections: ['Grade 1 - A']});
    await setDoc(doc(db, 'staff/adv2'), {role: 'adviser', email: 'v2@x.com', name: 'Adv 2', sections: ['Grade 2 - B']});
    await setDoc(doc(db, 'kids/k1'), {name: 'Kid One', section: 'Grade 1 - A', parentEmails: ['p@x.com']});
    await setDoc(doc(db, 'kidPhotos/k1'), {photo: 'data:image/jpeg;base64,AAAA', section: 'Grade 1 - A', parentEmails: ['p@x.com']});
  });
});
const as = uid => env.authenticatedContext(uid).firestore();
const parent = email => env.authenticatedContext('u-' + email, {email, email_verified: true}).firestore();

// ---------------------------------------------------------------- /log
test('log: gate staff can record a normal tap', async () => {
  await assertSucceeds(addDoc(collection(as('gate'), 'log'), tap()));
});
test('log: admin can too', async () => {
  await assertSucceeds(addDoc(collection(as('admin'), 'log'), tap()));
});
test('log: advisers, parents and signed-out users cannot create taps', async () => {
  await assertFails(addDoc(collection(as('adv1'), 'log'), tap()));
  await assertFails(addDoc(collection(parent('p@x.com'), 'log'), tap()));
  await assertFails(addDoc(collection(env.unauthenticatedContext().firestore(), 'log'), tap()));
});
test('log: unknown fields, bad type and unknown child are refused', async () => {
  const db = as('gate');
  await assertFails(addDoc(collection(db, 'log'), tap({extra: 1})));
  await assertFails(addDoc(collection(db, 'log'), tap({type: 'teleport'})));
  await assertFails(addDoc(collection(db, 'log'), tap({kidId: 'nobody'})));
});
test('log: time must be real: not in the future, not older than 2 days', async () => {
  const db = as('gate');
  await assertFails(addDoc(collection(db, 'log'), tap({time: now() + HOUR})));
  await assertFails(addDoc(collection(db, 'log'), tap({time: now() - 3 * DAY})));
  await assertSucceeds(addDoc(collection(db, 'log'), tap({time: now() - HOUR}))); // a tap saved offline an hour ago
  await assertFails(addDoc(collection(db, 'log'), tap({time: String(now())})));
});
test('log: a manual check-in must carry the staff member\'s own id', async () => {
  const db = as('gate');
  await assertFails(addDoc(collection(db, 'log'), tap({manual: true})));
  await assertFails(addDoc(collection(db, 'log'), tap({manual: true, by: 'someone-else'})));
  await assertSucceeds(addDoc(collection(db, 'log'), tap({manual: true, by: 'gate'})));
});
test('log: taps can never be deleted; only admins can fix name/section/emails', async () => {
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'log/t1'), tap()));
  await assertFails(deleteDoc(doc(as('admin'), 'log/t1')));
  await assertFails(updateDoc(doc(as('gate'), 'log/t1'), {name: 'X'}));
  await assertSucceeds(updateDoc(doc(as('admin'), 'log/t1'), {name: 'X'}));
  await assertFails(updateDoc(doc(as('admin'), 'log/t1'), {time: 1}));
});
test('log: a parent reads only their own child\'s taps', async () => {
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'log/t1'), tap()));
  const q = e => getDocs(query(collection(parent(e), 'log'), where('parentEmails', 'array-contains', e)));
  assert.equal((await assertSucceeds(q('p@x.com'))).size, 1);
  await assertFails(getDocs(collection(parent('p@x.com'), 'log')));         // cannot read everything
  await assertFails(getDocs(query(collection(parent('other@x.com'), 'log'), where('parentEmails', 'array-contains', 'p@x.com')))); // asking for someone else's child
});

// ---------------------------------------------------------------- /kidPhotos
test('kidPhotos: only managers write; size and fields are limited', async () => {
  const ok = {photo: 'data:image/jpeg;base64,BBBB', section: 'Grade 1 - A', parentEmails: ['p@x.com']};
  await assertSucceeds(setDoc(doc(as('admin'), 'kidPhotos/k2'), ok));
  await assertFails(setDoc(doc(as('gate'), 'kidPhotos/k2'), ok));
  await assertFails(setDoc(doc(as('adv1'), 'kidPhotos/k2'), ok));
  await assertFails(setDoc(doc(as('admin'), 'kidPhotos/k2'), {...ok, extra: 1}));
  await assertFails(setDoc(doc(as('admin'), 'kidPhotos/k2'), {...ok, photo: 'x'.repeat(150001)}));
});
test('kidPhotos: read by the right people only', async () => {
  await assertSucceeds(getDoc(doc(as('gate'), 'kidPhotos/k1')));
  await assertSucceeds(getDoc(doc(as('head'), 'kidPhotos/k1')));
  await assertSucceeds(getDoc(doc(as('tv'), 'kidPhotos/k1')));
  await assertSucceeds(getDoc(doc(as('adv1'), 'kidPhotos/k1')));        // their own section
  await assertFails(getDoc(doc(as('adv2'), 'kidPhotos/k1')));           // another section
  await assertSucceeds(getDoc(doc(parent('p@x.com'), 'kidPhotos/k1')));
  await assertFails(getDoc(doc(parent('other@x.com'), 'kidPhotos/k1')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'kidPhotos/k1')));
});

// ---------------------------------------------------------------- /holidays
test('holidays: everyone on staff reads; only admins write, with a date id', async () => {
  const h = {name: 'Bonifacio Day', time: now(), by: 'admin'};
  await assertSucceeds(setDoc(doc(as('admin'), 'holidays/2026-11-30'), h));
  await assertFails(setDoc(doc(as('admin'), 'holidays/not-a-date'), h));
  await assertFails(setDoc(doc(as('admin'), 'holidays/2026-12-01'), {...h, by: 'someone'}));
  await assertFails(setDoc(doc(as('adv1'), 'holidays/2026-12-02'), {...h, by: 'adv1'}));
  await assertSucceeds(getDoc(doc(as('adv1'), 'holidays/2026-11-30')));
  await assertFails(getDoc(doc(parent('p@x.com'), 'holidays/2026-11-30')));
  await assertSucceeds(deleteDoc(doc(as('admin'), 'holidays/2026-11-30')));
});

// ---------------------------------------------------------------- /consents
test('consents: a parent records their own agreement once; nobody edits it', async () => {
  const db = parent('p@x.com'), uid = 'u-p@x.com';
  const rec = {email: 'p@x.com', time: now(), version: 1};
  await assertSucceeds(setDoc(doc(db, 'consents/' + uid), rec));
  await assertFails(setDoc(doc(db, 'consents/' + uid), {...rec, version: 2}));       // update
  await assertFails(setDoc(doc(db, 'consents/someone-else'), rec));                  // other uid
  await assertFails(setDoc(doc(parent('q@x.com'), 'consents/u-q@x.com'), rec));      // email mismatch
  await assertSucceeds(getDoc(doc(as('admin'), 'consents/' + uid)));
  await assertFails(getDoc(doc(parent('q@x.com'), 'consents/' + uid)));
});

// ---------------------------------------------------------------- misc: things that must stay closed
test('staff list: admins add staff; a gate account cannot read the staff list or make itself admin', async () => {
  await assertFails(getDoc(doc(as('gate'), 'staff/admin')));
  await assertFails(setDoc(doc(as('gate'), 'staff/gate'), {role: 'admin'}));
  await assertSucceeds(setDoc(doc(as('admin'), 'staff/new1'), {role: 'adviser', email: 'n@x.com', sections: []}));
});
