const test = require('node:test');
const assert = require('node:assert/strict');
const {appLogic, functionsLogic} = require('./load');

const T = (y, m, d, h = 7, min = 0) => new Date(y, m - 1, d, h, min).getTime();

// ---------- tap type (in / lunch / back / out) ----------
test('nextType: first tap of the day is an arrival', () => {
  const L = appLogic({fields: {sfLunchA: '11:00', sfLunchB: '13:00'}});
  assert.equal(L.nextType(undefined, T(2026, 10, 5, 7, 0)), 'in');
});
test('nextType: leaving outside the lunch window is "out"; inside it is "lunch"; next tap is "back"', () => {
  const L = appLogic({fields: {sfLunchA: '11:00', sfLunchB: '13:00'}});
  assert.equal(L.nextType({type: 'in'}, T(2026, 10, 5, 16, 30)), 'out');
  assert.equal(L.nextType({type: 'in'}, T(2026, 10, 5, 11, 30)), 'lunch');
  assert.equal(L.nextType({type: 'lunch'}, T(2026, 10, 5, 12, 40)), 'back');
  assert.equal(L.nextType({type: 'back'}, T(2026, 10, 5, 16, 30)), 'out');
});
test('nextType: lunch window edges (start counts, end does not)', () => {
  const L = appLogic({fields: {sfLunchA: '11:00', sfLunchB: '13:00'}});
  assert.equal(L.inLunch(T(2026, 10, 5, 11, 0)), true);
  assert.equal(L.inLunch(T(2026, 10, 5, 13, 0)), false);
  assert.equal(L.inLunch(T(2026, 10, 5, 10, 59)), false);
});
test('nextType: with lunch turned off a leave is always "out"', () => {
  const L = appLogic({fields: {sfLunchA: '', sfLunchB: ''}});
  assert.equal(L.nextType({type: 'in'}, T(2026, 10, 5, 12, 0)), 'out');
});
test('nextType: a tap after "out" starts a new arrival', () => {
  const L = appLogic({fields: {sfLunchA: '11:00', sfLunchB: '13:00'}});
  assert.equal(L.nextType({type: 'out'}, T(2026, 10, 5, 17, 0)), 'in');
});

// ---------- SF2 counting ----------
// October 2026: Thu 1, Fri 2, Sat 3, Sun 4, Mon 5, Tue 6 ...
const kidsA = [{id: 'a', name: 'A'}, {id: 'b', name: 'B'}];
const base = {year: 2026, month: 9, cutoff: '07:30', today: new Date(2026, 9, 31)};
const day = (r, d) => r.days[d - 1];

test('SF2: a weekday is a class day only when somebody tapped; weekends and empty days are not', () => {
  const L = appLogic();
  const lg = [{kidId: 'a', time: T(2026, 10, 1, 7, 0)}, {kidId: 'a', time: T(2026, 10, 3, 7, 0)}]; // Thu and a Saturday
  const r = L.buildSF2(kidsA, lg, base);
  assert.equal(day(r, 1).cls, true);
  assert.equal(day(r, 2).cls, false, 'Friday with no taps');
  assert.equal(day(r, 3).cls, false, 'Saturday');
  assert.equal(r.schoolDays, 1);
});
test('SF2: late is strictly after the cut-off; absent when a class day has no tap', () => {
  const L = appLogic();
  const lg = [
    {kidId: 'a', time: T(2026, 10, 1, 7, 30)}, {kidId: 'b', time: T(2026, 10, 1, 7, 31)}, // Thu 1: on time vs late
    {kidId: 'a', time: T(2026, 10, 2, 7, 0)}                                              // Fri 2: b has no tap
  ];
  const r = L.buildSF2(kidsA, lg, base);
  assert.equal(r.rows[0].marks[0], 'P', '07:30 is on time');
  assert.equal(r.rows[1].marks[0], 'T', '07:31 is late');
  assert.equal(r.rows[1].marks[1], 'A');
  assert.equal(r.rows[1].abs, 1);
  assert.equal(r.rows[1].tar, 1);
});
test('SF2: the first tap of the day decides, later taps do not change it', () => {
  const L = appLogic();
  const lg = [{kidId: 'a', time: T(2026, 10, 1, 8, 15)}, {kidId: 'a', time: T(2026, 10, 1, 7, 10)}, {kidId: 'a', time: T(2026, 10, 1, 16, 0)}];
  assert.equal(L.buildSF2([kidsA[0]], lg, base).rows[0].marks[0], 'P');
});
test('SF2: holidays are not class days, even if somebody tapped; a manual override wins', () => {
  const L = appLogic();
  const lg = [{kidId: 'a', time: T(2026, 10, 1, 7, 0)}, {kidId: 'a', time: T(2026, 10, 2, 7, 0)}];
  const h = {'2026-10-01': 'Test holiday'};
  assert.equal(L.buildSF2(kidsA, lg, {...base, holidays: h}).days[0].cls, false);
  assert.equal(L.buildSF2(kidsA, lg, {...base, holidays: h}).schoolDays, 1);
  assert.equal(L.buildSF2(kidsA, lg, {...base, holidays: h, overrides: {1: true}}).days[0].cls, true);
});
test('SF2: future days are never class days', () => {
  const L = appLogic();
  const lg = [{kidId: 'a', time: T(2026, 10, 20, 7, 0)}];
  const r = L.buildSF2(kidsA, lg, {...base, today: new Date(2026, 9, 10)});
  assert.equal(day(r, 20).cls, false);
});
test('SF2: a teacher adjustment replaces the computed mark', () => {
  const L = appLogic();
  const lg = [{kidId: 'a', time: T(2026, 10, 1, 7, 0)}, {kidId: 'b', time: T(2026, 10, 1, 7, 0)}];
  const r = L.buildSF2(kidsA, lg, {...base, adj: {'b|1': 'A'}});
  assert.equal(r.rows[1].marks[0], 'A');
  assert.equal(r.rows[1].abs, 1);
});
test('SF2: longest streak of absences counts class days in a row and resets after a present day', () => {
  const L = appLogic();
  // Mon 5 .. Fri 9 absent, Mon 12 present, Tue 13 absent. "a" taps every day so each is a class day.
  const lg = [];
  for (const d of [5, 6, 7, 8, 9, 12, 13]) lg.push({kidId: 'a', time: T(2026, 10, d, 7, 0)});
  lg.push({kidId: 'b', time: T(2026, 10, 12, 7, 0)});
  const r = L.buildSF2(kidsA, lg, base);
  assert.equal(r.rows[1].streak, 5);
  assert.equal(r.rows[1].abs, 6);
});

// ---------- CSV import ----------
test('CSV: handles BOM, quoted commas, CRLF, sex words, date formats and a combined section', () => {
  const L = appLogic();
  const csv = '﻿Last Name,First Name,Sex,Grade,Section,LRN,Birthdate,Phone,Email\r\n"Dela Cruz, Jr.",Juan,Male,Grade 3,Rizal,222,5/20/2017,0917,A@B.com\r\n';
  const [r] = L.impPrepare(csv).rows;
  assert.equal(r.status, 'ok');
  assert.equal(r.last, 'Dela Cruz, Jr.');
  assert.equal(r.sex, 'M');
  assert.equal(r.section, 'Grade 3 - Rizal');
  assert.equal(r.birthdate, '2017-05-20');
  assert.deepEqual(r.emails, ['a@b.com']);
});
test('CSV: skips children already in the list (same LRN or same name) and repeats inside the file', () => {
  const L = appLogic({kids: [{name: 'Lacap, Maya, Torres', lrn: '111'}]});
  const csv = 'Last name,First name,LRN\nLacap,Maya,\nOther,Kid,111\nNew,One,\nNew,One,\n';
  const st = L.impPrepare(csv).rows.map(r => r.status);
  assert.deepEqual(st, ['dup', 'dup', 'ok', 'dup']);
});
test('CSV: rows without a first or last name are errors; warnings for missing email, phone, section', () => {
  const L = appLogic();
  const rows = L.impPrepare('Last name,First name\n,Ana\nSanto,Ben\n').rows;
  assert.equal(rows[0].status, 'error');
  assert.equal(rows[1].status, 'ok');
  assert.deepEqual(rows[1].warn, ['no parent email', 'no phone', 'no section']);
});
test('CSV: a single Name column and a semicolon separator both work', () => {
  const L = appLogic();
  // The app stores names as "Last, First, Middle" (comma separated), so "X, Y Z" is last X and first name "Y Z".
  const [r] = L.impPrepare('Name;Grade\nX, Y Z;G1\n').rows;
  assert.deepEqual([r.last, r.first, r.mid, r.section], ['X', 'Y Z', '', 'G1']);
  const [q] = L.impPrepare('Name,Grade\n"Cruz, Ana, Lopez",G1\n').rows;
  assert.deepEqual([q.last, q.first, q.mid], ['Cruz', 'Ana', 'Lopez']);
});
test('CSV: a file without name columns gives a clear error', () => {
  const L = appLogic();
  assert.match(L.impPrepare('Foo,Bar\n1,2\n').err, /name columns/);
});

// ---------- Cloud Function: Manila time ----------
test('manilaNow: converts UTC to Manila date and minutes', () => {
  const {manilaNow} = functionsLogic();
  const t = manilaNow(new Date('2026-10-22T00:30:00Z'));
  assert.equal(t.iso, '2026-10-22');
  assert.equal(t.minutes, 8 * 60 + 30);
  assert.equal(t.start, Date.parse('2026-10-22T00:00:00+08:00'));
});
test('manilaNow: crosses the date line correctly (UTC evening is already tomorrow in Manila)', () => {
  const {manilaNow} = functionsLogic();
  const t = manilaNow(new Date('2026-12-31T17:00:00Z'));
  assert.equal(t.iso, '2027-01-01');
  assert.equal(t.ds, '2027-1-1', 'same unpadded format the app uses for alert ids');
  assert.equal(t.minutes, 60);
});
