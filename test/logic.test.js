// node test/logic.test.js
const assert = require('assert');
const { L, S } = require('./run.js');
const M = S.master, R = S.requests;
const cells = L.generate(M, R, 2026, 8);
const v = L.validate(M, R, cells, 2026, 8);
const stores = M.stores.map(s => s.code);
let ok = 0;
function t(name, fn) { fn(); ok++; console.log('ok -', name); }

const personRules = ['連勤', '週の休み', '出勤できない曜日', '深夜勤（0-9）の日に', '夜勤できない', '準夜勤から続けて', '営業していません', '店舗出勤が週'];
t('社員ごとの必ず守るルールに違反がない', () => {
  const bad = v.issues.filter(i => i.level === 'error' && personRules.some(k => i.msg.includes(k)));
  assert.strictEqual(bad.length, 0, JSON.stringify(bad));
});
t('事前に決まっている枠（希望）はそのまま残る', () => {
  for (const id in R) for (const d in R[id]) for (const k of ['AM', 'PM', 'N']) {
    const want = R[id][d][k];
    if (want && want !== '出') assert.strictEqual(cells[id][d][k], want, id + ' ' + d + ' ' + k);
  }
});
t('固定配置の人は所属店舗以外に入らない', () => {
  for (const s of M.staff.filter(s => s.fixed)) for (const d in cells[s.id]) for (const k of ['AM', 'PM']) {
    const x = cells[s.id][d][k];
    if (stores.includes(x) && !(R[s.id] && R[s.id][d] && R[s.id][d][k])) assert.strictEqual(x, s.home, s.name + ' ' + d);
  }
});
t('当番日の準夜勤と翌日の深夜勤が埋まる', () => {
  for (const d of M.dutyDates) {
    const eve = M.staff.filter(s => cells[s.id][d] && cells[s.id][d].N === '準夜').length;
    assert.strictEqual(eve, 1, d);
    const nd = L.addDays(d, 1);
    const late = M.staff.filter(s => cells[s.id][nd] && cells[s.id][nd].N === '深夜').length;
    assert.strictEqual(late, 1, nd);
  }
});
t('日曜の当番日に三番町の日中が1人入る', () => {
  const n = M.staff.filter(s => cells[s.id]['2026-08-09'].AM === '三').length;
  assert.ok(n >= 1);
});
t('在宅の人は週1回在宅・店舗は週4日以下', () => {
  const w = M.staff.find(s => s.weeklyRemote);
  const wk = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22'];
  const remote = wk.filter(d => cells[w.id][d].AM === '在宅').length;
  const store = wk.filter(d => stores.includes(cells[w.id][d].AM) || stores.includes(cells[w.id][d].PM)).length;
  assert.strictEqual(remote, 1); assert.ok(store <= 4);
});
t('手で違反を作ると判定で検出できる', () => {
  const c2 = JSON.parse(JSON.stringify(cells));
  const b = M.staff.find(s => s.name === '管薬B');
  c2[b.id]['2026-08-03'].AM = '松';
  const nightless = M.staff.find(s => !s.night);
  c2[nightless.id]['2026-08-17'].N = '準夜';
  const v2 = L.validate(M, R, c2, 2026, 8);
  assert.ok(v2.issues.some(i => i.msg.includes('固定配置')));
  assert.ok(v2.issues.some(i => i.msg.includes('夜勤できない')));
});
console.log(ok + ' passed');
