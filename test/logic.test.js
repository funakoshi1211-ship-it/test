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
  assert.ok(v2.issues.some(i => i.msg.includes('勤に入れない人')));
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
t('日曜の半日営業（臨時営業・午前）：必要な人数だけ入り、1日の出勤として代休が付く', () => {
  const M7 = Object.assign({}, M, { extraOpen: [{ date: '2026-08-23', store: '中', slot: 'AM' }] });
  const c7 = L.generate(M7, R, 2026, 8);
  const v7 = L.validate(M7, R, c7, 2026, 8);
  const d = '2026-08-23';
  const ph = M.staff.filter(s => s.job !== '事務' && c7[s.id][d].AM === '中');
  const cl = M.staff.filter(s => s.job === '事務' && c7[s.id][d].AM === '中');
  assert.strictEqual(ph.length, 2, '薬剤師は土曜と同じ2人'); assert.strictEqual(cl.length, 1, '事務は1人');
  assert.ok(M.staff.every(s => c7[s.id][d].PM !== '中'), '午後は営業しない');
  const regs = ph.concat(cl).filter(s => s.kind === '常勤' || s.kind === '準常勤');
  const wk = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29'];
  regs.forEach(s => assert.ok(wk.some(x => c7[s.id][x].AM === '代休'), s.name + ' に代休'));
  assert.ok(!v7.issues.some(i => i.level === 'error' && /連勤|公休/.test(i.msg)), JSON.stringify(v7.issues.filter(i => /連勤|公休/.test(i.msg))));
});
t('店舗だけの休業日：その店舗でしか働けない正社員は有給、応援できる人は他の店舗へ。公休は週2日のまま', () => {
  const M8 = Object.assign({}, M, { holidays: M.holidays.concat([{ date: '2026-08-19', name: '地方祭', store: '中' }]) });
  const c8 = L.generate(M8, R, 2026, 8);
  const v8 = L.validate(M8, R, c8, 2026, 8);
  const d = '2026-08-19';
  const C = M.staff.find(s => s.name === '管薬C');      // 中一万に固定
  const F = M.staff.find(s => s.name === '薬剤師F');    // 中一万所属・山越と一番町に応援可
  assert.strictEqual(c8[C.id][d].AM, '有給');
  assert.ok(['山', '一'].includes(c8[F.id][d].AM) || ['山', '一'].includes(c8[F.id][d].PM), '応援に出る：' + JSON.stringify(c8[F.id][d]));
  assert.ok(!v8.issues.some(i => i.id === C.id && /公休/.test(i.msg)), '公休は足りている');
  assert.ok(!v8.issues.some(i => /代休/.test(i.msg) && i.id === F.id), '平日の店舗休業は代休の対象外');
  // 「公休」扱いにした日は、これまでどおり公休
  const M9 = Object.assign({}, M, { holidays: M.holidays.concat([{ date: d, name: '地方祭', store: '中', mode: '公休' }]) });
  const c9 = L.generate(M9, R, 2026, 8);
  assert.notStrictEqual(c9[C.id][d].AM, '有給');
});
t('曜日別の必要人数（月〜土の行）は平日・土曜の行より優先される', () => {
  const reqs = M.requirements.concat([{ store: '松', dayType: '水', slot: 'AM', pharm: 3, clerk: 2 }]);
  const MA = Object.assign({}, M, { requirements: reqs });
  const vA = L.validate(MA, R, cells, 2026, 8);
  assert.strictEqual(vA.counts['松']['2026-08-05'].AM.pharm.min, 3, '水曜は3人');
  assert.strictEqual(vA.counts['松']['2026-08-04'].AM.pharm.min, 2, '火曜は平日の2人のまま');
  assert.strictEqual(vA.counts['松']['2026-08-05'].PM.pharm.min, 2, '水曜の午後は行がないので平日の2人');
});
t('「一※」「※三」「重信」など※・重信・支回を含む書き方は人数に数えない', () => {
  const c7 = JSON.parse(JSON.stringify(cells));
  const a = M.staff.find(s => s.name === '管薬A');
  const d = '2026-08-05';
  const base = v.counts['一'][d].AM.pharm.have - (cells[a.id][d].AM === '一' ? 1 : 0);
  ['一※', '※一', '一 重信', '支回'].forEach(val => {
    c7[a.id][d] = { AM: val, PM: val, N: '' };
    const v7 = L.validate(M, R, c7, 2026, 8);
    assert.strictEqual(v7.counts['一'][d].AM.pharm.have, base, val);
  });
  c7[a.id][d] = { AM: '一 8:30', PM: '', N: '' };
  assert.strictEqual(L.validate(M, R, c7, 2026, 8).counts['一'][d].AM.pharm.have, base + 1, '時刻つきは数える');
});
t('午前のみ有給：午後は通常どおり勤務し、有給は0.5日、出勤日として数える', () => {
  const R2 = JSON.parse(JSON.stringify(R));
  const I = M.staff.find(s => s.name === '薬剤師I');   // 松山・常勤
  const d = '2026-08-18';
  R2[I.id] = R2[I.id] || {};
  R2[I.id][d] = { AM: '有給', PM: '', N: '' };
  const c2 = L.generate(M, R2, 2026, 8);
  const v2 = L.validate(M, R2, c2, 2026, 8);
  assert.strictEqual(c2[I.id][d].AM, '有給');
  assert.strictEqual(c2[I.id][d].PM, '松', '午後は勤務');
  assert.strictEqual(v2.summary[I.id].leave, 0.5);
  assert.ok(!v2.issues.some(i => i.id === I.id && /公休|連勤/.test(i.msg)), JSON.stringify(v2.issues.filter(i => i.id === I.id)));
  // その週の公休（日曜＋定休）は別に2日ある
  const wk = ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22'];
  const rest = wk.filter(x => { const c = c2[I.id][x]; return !c.N && !['松', '有給'].includes(c.AM) && !['松'].includes(c.PM) && c.AM !== '有給'; }).length;
  assert.ok(rest >= 2, 'rest=' + rest);
});
t('夜勤の種類（準夜のみ・深夜のみ）と、日ごとの「夜可」「夜×」', () => {
  // 管薬B は準夜のみ、薬剤師G は深夜のみ、薬剤師H は8/17に夜×
  const staff = M.staff.map(s => s.name === '管薬B' ? Object.assign({}, s, { nightType: 'eve' }) : s.name === '薬剤師G' ? Object.assign({}, s, { nightType: 'late' }) : s);
  const MB = Object.assign({}, M, { staff });
  const RB = JSON.parse(JSON.stringify(R));
  const H = staff.find(s => s.name === '薬剤師H');
  RB[H.id] = RB[H.id] || {}; RB[H.id]['2026-08-17'] = { AM: '', PM: '', N: '夜×' };
  const cB = L.generate(MB, RB, 2026, 8);
  const vB = L.validate(MB, RB, cB, 2026, 8);
  const B = staff.find(s => s.name === '管薬B'), G = staff.find(s => s.name === '薬剤師G');
  Object.keys(cB[B.id]).forEach(d => assert.notStrictEqual(cB[B.id][d].N, '深夜', 'Bは深夜に入らない ' + d));
  Object.keys(cB[G.id]).forEach(d => assert.notStrictEqual(cB[G.id][d].N, '準夜', 'Gは準夜に入らない ' + d));
  assert.strictEqual(cB[H.id]['2026-08-17'].N, '', 'Hは8/17に夜勤なし');
  assert.ok(!vB.issues.some(i => /勤に入れない人|夜×/.test(i.msg)));
  // 日中は休み（休）だが、夜可なら深夜に入れる
  const RC = JSON.parse(JSON.stringify(R));
  const J = M.staff.find(s => s.name === '薬剤師H');
  RC[J.id] = RC[J.id] || {}; RC[J.id]['2026-08-18'] = { AM: '休', PM: '休', N: '夜可' };
  const staff2 = M.staff.map(s => s.name === '夜勤P' ? Object.assign({}, s, { nightType: '' , night: false }) : s.name === '薬剤師G' ? Object.assign({}, s, { nightType: '', night: false }) : s.name === '管薬B' ? Object.assign({}, s, { nightType: 'eve' }) : s);
  const RC2 = JSON.parse(JSON.stringify(RC)); delete RC2['S16'];
  const cC = L.generate(Object.assign({}, M, { staff: staff2 }), RC2, 2026, 8);
  assert.strictEqual(cC[J.id]['2026-08-18'].N, '深夜', '夜可で深夜に入る');
});
t('日曜の当番日：日中（8:30-17:30）・準夜・翌日の深夜に、それぞれ別の薬剤師が1人ずつ', () => {
  const d = '2026-08-09', nd = '2026-08-10';
  const day = M.staff.filter(s => s.job !== '事務' && cells[s.id][d].AM === '三' && cells[s.id][d].PM === '三');
  const eve = M.staff.filter(s => cells[s.id][d].N === '準夜');
  const late = M.staff.filter(s => cells[s.id][nd].N === '深夜');
  assert.strictEqual(day.length, 1, '日中は同じ1人が午前・午後');
  assert.strictEqual(eve.length, 1); assert.strictEqual(late.length, 1);
  const ids = new Set([day[0].id, eve[0].id, late[0].id]);
  assert.strictEqual(ids.size, 3, '3人とも別の人');
});
t('固定でない正社員の薬剤師は、応援できる店舗が空欄ならどの店舗にも応援に出られる', () => {
  // 薬剤師I（松山・常勤・応援先の指定なし）。松山に余裕がある日に一番町が足りなければ移動できる
  const staff = M.staff.map(s => s.name === '管薬E' ? s : s);
  const RI = JSON.parse(JSON.stringify(R));
  const A = M.staff.find(s => s.name === '管薬A');
  RI[A.id]['2026-08-05'] = { AM: '休', PM: '休', N: '' };       // 一番町の薬剤師がいない日
  const K = M.staff.find(s => s.name === '薬剤師K');
  RI[K.id] = RI[K.id] || {}; RI[K.id]['2026-08-05'] = { AM: '出', PM: '出', N: '' }; // 松山に余裕を作る
  const cI = L.generate(M, RI, 2026, 8);
  const vI = L.validate(M, RI, cI, 2026, 8);
  assert.strictEqual(vI.counts['一']['2026-08-05'].AM.pharm.have >= 1, true, '一番町の午前が埋まる');
  assert.ok(!vI.issues.some(i => /出勤できる店舗に入っていません/.test(i.msg) && M.staff.find(s => s.id === i.id).name === '薬剤師I'));
});
t('自動で入れた非常勤は、最低人数を超える枠には残らない', () => {
  const parts = M.staff.filter(s => s.kind === '非常勤');
  Object.keys(cells[parts[0].id]).forEach(d => ['AM', 'PM'].forEach(k => ['pharm', 'clerk'].forEach(role => {
    stores.forEach(st => {
      const c = v.counts[st][d][k][role];
      if (!c || c.have <= c.min) return;
      const autoPart = parts.filter(s => (role === 'clerk') === (s.job === '事務') && cells[s.id][d][k] === st && !(R[s.id] && R[s.id][d] && R[s.id][d][k]));
      assert.strictEqual(autoPart.length, 0, st + ' ' + d + ' ' + k + ' ' + role + ' に余分な非常勤 ' + autoPart.map(s => s.name));
    });
  })));
});
t('曜日別の必要人数で山越の木曜午後を1人にすると、木曜午後に余分な非常勤が入らない', () => {
  const MY = Object.assign({}, M, { requirements: M.requirements.concat([{ store: '山', dayType: '木', slot: 'PM', pharm: 1, clerk: 1 }]) });
  const cY = L.generate(MY, R, 2026, 8);
  const vY = L.validate(MY, R, cY, 2026, 8);
  ['2026-08-06', '2026-08-13', '2026-08-20', '2026-08-27'].forEach(d => {
    const c = vY.counts['山'][d].PM.pharm;
    if (c) assert.ok(c.have <= Math.max(1, M.staff.filter(s => s.kind !== '非常勤' && cY[s.id][d].PM === '山').length), d + ' have=' + c.have);
  });
});
console.log(ok + ' passed');
