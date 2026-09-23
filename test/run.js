// Logic.html / SampleData.html の <script> を取り出して Node で実行する
const fs = require('fs'), path = require('path'), vm = require('vm');
function load(f) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8');
  return src.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
}
const sandbox = { module: undefined, console };
vm.createContext(sandbox);
vm.runInContext(load('Logic.html') + '\n;this.ShiftLogic=ShiftLogic;', sandbox);
vm.runInContext(load('SampleData.html') + '\n;this.SAMPLE=SAMPLE;', sandbox);
module.exports = { L: sandbox.ShiftLogic, S: sandbox.SAMPLE };
if (require.main === module) {
  const { L, S } = module.exports;
  const t0 = Date.now();
  const cells = L.generate(S.master, S.requests, 2026, 8);
  const v = L.validate(S.master, S.requests, cells, 2026, 8);
  console.log('time', Date.now() - t0, 'ms');
  const errs = v.issues.filter(i => i.level === 'error'), warns = v.issues.filter(i => i.level === 'warn');
  console.log('errors', errs.length, 'warns', warns.length);
  errs.forEach(i => console.log('E', i.date, i.msg));
  warns.slice(0, 40).forEach(i => console.log('W', i.date, i.msg));
  // grid
  const days = Object.keys(cells.S1).sort();
  for (const s of S.master.staff) {
    let a = '', p = '', n = '';
    for (const d of days) { const c = cells[s.id][d]; a += (c.AM || '・').slice(0,1); p += (c.PM || '・').slice(0,1); n += (c.N ? c.N.slice(0,1) : ' '); }
    console.log(s.name.padEnd(5, '　'), a); console.log('     　', p); if (n.trim()) console.log('     夜', n);
  }
}
