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
t('深夜勤の前日は午前だけ（午後は「入」）', () => {
  for (const d of M.dutyDates) {
    const nd = L.addDays(d, 1);
    const p = M.staff.find(s => cells[s.id][nd] && cells[s.id][nd].N === '深夜');
    if (!p || !cells[p.id][d]) continue;
    assert.ok(!stores.includes(cells[p.id][d].PM), p.name + ' ' + d + ' PM=' + cells[p.id][d].PM);
  }
});
t('有給・特休は公休（週2日）とは別に取る', () => {
  // 管薬D は 8/12-14 が有給。同じ週に公休（日曜＋1日）が別にある
  const d = M.staff.find(s => s.name === '管薬D');
  const wk = ['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
  const rest = wk.filter(x => { const c = cells[d.id][x]; return !stores.includes(c.AM) && !stores.includes(c.PM) && !['有給', '特休'].includes(c.AM) && !c.N; }).length;
  assert.ok(rest >= 2, 'rest=' + rest);
});
t('非常勤は週の出勤上限を超えない', () => {
  const bad = v.issues.filter(i => i.msg.includes('日出勤（上限'));
  assert.strictEqual(bad.length, 0, JSON.stringify(bad));
});
t('月末の日曜が当番日でも7連勤にならない（2026年11月）', () => {
  const M2 = Object.assign({}, M, {
    holidays: [{ date: '2026-11-03', name: '文化の日' }, { date: '2026-11-23', name: '勤労感謝の日' }],
    dutyDates: ['2026-11-05', '2026-11-13', '2026-11-21', '2026-11-29'], specialPeriods: []
  });
  const c2 = L.generate(M2, {}, 2026, 11);
  const v2 = L.validate(M2, {}, c2, 2026, 11);
  const bad = v2.issues.filter(i => i.msg.includes('連勤'));
  assert.strictEqual(bad.length, 0, JSON.stringify(bad));
});
t('休みにしたい曜日（できれば）を優先して定休にする', () => {
  const staff = M.staff.map(x => x.name === '事務V' ? Object.assign({}, x, { prefOffWeekdays: [3] }) : x);
  const M3 = Object.assign({}, M, { staff });
  const c3 = L.generate(M3, R, 2026, 8);
  const q = staff.find(x => x.name === '事務V');
  const weds = ['2026-08-05', '2026-08-19', '2026-08-26'];
  const off = weds.filter(d => c3[q.id][d].AM === '定休').length;
  assert.ok(off >= 2, '水曜の定休 ' + off + '/3');
});
// 年末年始：店舗ごとに休業日が違う
const MD = Object.assign({}, M, {
  holidays: [
    { date: '2027-01-01', name: '元日' }, { date: '2027-01-02', name: '年始休業' },
    { date: '2026-12-29', name: '年末休業', store: '一' }, { date: '2026-12-30', name: '年末休業', store: '一' },
    { date: '2026-12-31', name: '年末休業', store: '一' }, { date: '2026-12-31', name: '年末休業', store: '松' }
  ],
  dutyDates: [], extraOpen: [],
  specialPeriods: [{ name: '年末年始', start: '2026-12-28', end: '2027-01-04', targetOff: 4, overflow: '有給' }],
  specialReqs: []
});
const cD = L.generate(MD, {}, 2026, 12);
const vD = L.validate(MD, {}, cD, 2026, 12);
t('店舗ごとの休業日：その店舗だけ誰も配置されない', () => {
  for (const s of M.staff) for (const k of ['AM', 'PM']) {
    assert.notStrictEqual(cD[s.id]['2026-12-29'][k], '一', s.name);
    assert.notStrictEqual(cD[s.id]['2026-12-31'][k], '松', s.name);
  }
  assert.ok(M.staff.some(s => cD[s.id]['2026-12-29'].AM === '三'), '三番町は営業している');
});
t('特別期間の公休を正社員でそろえ、休業日が多い人の多い分は有給にする', () => {
  const regs = M.staff.filter(s => s.kind === '常勤' || s.kind === '準常勤');
  regs.forEach(s => assert.strictEqual(vD.summary[s.id].periods[0].off, 4, s.name + ' の公休'));
  // 一番町の正社員（休業日が多い）は、多い分が有給になる
  const ichi = regs.filter(s => s.home === '一');
  ichi.forEach(s => assert.ok(['2026-12-29', '2026-12-30', '2026-12-31'].some(d => cD[s.id][d].AM === '有給'), s.name));
  // 休業日の少ない店舗の人に、有給は自動で入らない
  const san = regs.filter(s => s.home === '三');
  san.forEach(s => assert.ok(!Object.values(cD[s.id]).some(c => c.AM === '有給'), s.name));
});
t('祝日のある週は、祝日と日曜以外はすべて出勤（深夜勤の前日も午前は出勤）', () => {
  const M4 = Object.assign({}, M, { holidays: [{ date: '2026-11-03' }, { date: '2026-11-23' }],
    dutyDates: ['2026-11-05', '2026-11-13', '2026-11-21', '2026-11-29'], specialPeriods: [] });
  const c4 = L.generate(M4, {}, 2026, 11);
  const wk = ['2026-11-02', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
  M.staff.filter(s => s.kind === '常勤' || s.kind === '準常勤').forEach(s => {
    wk.forEach(d => {
      const c = c4[s.id][d];
      const working = stores.includes(c.AM) || stores.includes(c.PM) || ['※', '重信', '在宅'].includes(c.AM) || c.N;
      assert.ok(working, s.name + ' ' + d + ' ' + JSON.stringify(c));
    });
  });
});
t('準夜勤の人は、その日の日中は勤務せず人数に数えない。翌日は出勤できる', () => {
  let nextDayWork = 0;
  for (const d of M.dutyDates) {
    const p = M.staff.find(s => cells[s.id][d] && cells[s.id][d].N === '準夜');
    assert.ok(p, d);
    ['AM', 'PM'].forEach(k => assert.ok(!stores.includes(cells[p.id][d][k]), p.name + ' ' + d + ' ' + k + '=' + cells[p.id][d][k]));
    const nx = cells[p.id][L.addDays(d, 1)];
    if (nx && (stores.includes(nx.AM) || stores.includes(nx.PM))) nextDayWork++;
  }
  assert.ok(nextDayWork >= 1, '翌日に出勤している例がある');
});
t('手入力の文字（先頭が店舗記号）はその店舗の人数に数え、出勤日として扱う', () => {
  const c5 = JSON.parse(JSON.stringify(cells));
  const k = M.staff.find(s => s.name === '薬剤師K');
  const d = '2026-08-04';
  const before = v.counts['三'][d].AM.pharm.have;
  c5[k.id][d] = { AM: '三 8:30-14:30', PM: '研修', N: '' };
  const v5 = L.validate(M, R, c5, 2026, 8);
  assert.strictEqual(v5.counts['三'][d].AM.pharm.have, before + (cells[k.id][d].AM === '三' ? 0 : 1));
  assert.ok(!v5.issues.some(i => i.id === k.id && i.date === d && i.level === 'error'), '手入力の文字でエラーにならない');
});
t('午前のみの非常勤は午後に入らない', () => {
  const m = M.staff.find(s => s.name === '薬剤師M');
  Object.keys(cells[m.id]).forEach(d => assert.ok(!stores.includes(cells[m.id][d].PM), d));
});
t('日曜・祝日に出勤した人には、その週の追加の休みが「代休」で入る', () => {
  // 8/9（日）の当番日中に入った人
  const p = M.staff.filter(s => cells[s.id]['2026-08-09'] && cells[s.id]['2026-08-09'].AM === '三' && (s.kind === '常勤' || s.kind === '準常勤'));
  assert.ok(p.length >= 1);
  p.forEach(s => {
    const wk = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22'];
    const dai = wk.filter(d => cells[s.id][d] && cells[s.id][d].AM === '代休').length;
    const warn = v.issues.some(i => i.id === s.id && i.msg.includes('代休'));
    assert.ok(dai >= 1 || warn, s.name + ' に代休も警告もない');
  });
});
t('支回は出勤扱いだが、店舗の人数に数えない', () => {
  const c6 = JSON.parse(JSON.stringify(cells));
  const a = M.staff.find(s => s.name === '管薬A');
  const d = '2026-08-05';
  c6[a.id][d] = { AM: '支回', PM: '支回', N: '' };
  const v6 = L.validate(M, R, c6, 2026, 8);
  const before = v.counts['一'][d].AM.pharm.have - (stores.includes(cells[a.id][d].AM) ? 1 : 0);
  assert.strictEqual(v6.counts['一'][d].AM.pharm.have, before);
});
console.log(ok + ' passed');
