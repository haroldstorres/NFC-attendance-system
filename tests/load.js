// Pulls the real functions out of index.html and functions/index.js so the tests check the code that ships,
// without having to turn the single-file app into modules first.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const fns = fs.readFileSync(path.join(root, 'functions', 'index.js'), 'utf8');

function between(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) throw new Error('marker not found: ' + start);
  const b = src.indexOf(end, a);
  if (b < 0) throw new Error('marker not found: ' + end);
  return src.slice(a, b);
}

// stubs: values of form fields ($), the list of children, and the splitName helper from the app
function appLogic({fields = {}, kids = []} = {}) {
  const $ = id => ({value: fields[id] || ''});
  const splitName = n => { n = (n || '').trim(); if (n.includes(',')) { const p = n.split(',').map(x => x.trim()); return [p[0] || '', p[1] || '', p.slice(2).join(' ')]; } return [n, '', '']; };
  const tapCode = between(html, 'const AT=t=>', 'async function handleTap');
  const sf2 = between(html, 'function buildSF2', '// SF2-CORE-END');
  const imp = between(html, 'const IMPH=', 'function impRender');
  const ye = between(html, '// YEAREND-CORE-START', '// YEAREND-CORE-END');
  const body = `${tapCode}\n${sf2}\n${imp}\n${ye}\nreturn {nextType, inLunch, buildSF2, parseCsv, impPrepare, impBday, yearEndPlan, yearEndDefaults, nextGrade};`;
  return new Function('$', 'kids', 'splitName', body)($, kids, splitName);
}

function functionsLogic() {
  const code = "const TZ = 'Asia/Manila';\n" + between(fns, 'function manilaNow', 'exports.autoNotArrived');
  return new Function(code + '\nreturn {manilaNow};')();
}

module.exports = {appLogic, functionsLogic};
