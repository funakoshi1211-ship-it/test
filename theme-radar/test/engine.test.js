// 計算部分（Engine.gs）のテスト。実際の株価は使わず、2026年9〜10月のサイバー株に似せた合成データで確かめる
//   node theme-radar/test/engine.test.js
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Engine.gs'), 'utf8') + '\n;this.Radar=Radar;', ctx);
const R = ctx.Radar;

// 再現できる乱数
let seed = 7;
function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
function noise(s) { return (rnd() - 0.5) * 2 * s; }

const T = 170;
const dates = [];
for (let i = 0; i < T; i++) { const d = new Date(Date.UTC(2026, 3, 1) + i * 86400000); dates.push(d.toISOString().slice(0, 10)); }

function makeBars(start, plan) {
  // plan(i) → {r: 終値の騰落率, vm: 出来高の倍率, lu: ストップ高で引ける}
  const bars = []; let c = start;
  for (let i = 0; i < T; i++) {
    const p = plan(i) || {};
    let nc;
    if (p.lu) nc = c + R.limitWidth(c);
    else nc = Math.max(1, Math.round(c * (1 + (p.r !== undefined ? p.r : noise(0.012)))));
    const o = Math.round(c * (1 + (p.gap || 0)));
    bars.push({ d: dates[i], o: o, h: Math.max(o, nc), l: Math.min(o, nc), c: nc, v: Math.round(100000 * (p.vm || (1 + noise(0.3)))), ac: nc });
    c = nc;
  }
  return bars;
}

// 制限値幅：10/6 のサイバーセキュリティクラウド（2,118円→+500円）とカウリス（1,713円→+400円）
assert.strictEqual(R.limitWidth(2118), 500);
assert.strictEqual(R.limitWidth(1713), 400);
assert.strictEqual(R.limitWidth(99), 30);
assert.strictEqual(R.limitWidth(1500), 400);

// ベンチマーク（TOPIX）は小さく揺れるだけ
const bench = { bars: makeBars(3000, () => ({ r: noise(0.006) })) };

// サイバー：12銘柄。120日目から1銘柄がS高2連発（ZenmuTechに相当）、125日目に2銘柄が急騰（アズジェント・エルテス）、
// 129日目から一斉に急騰（10/6 に相当）、140日目以降は熱が冷める
const X = 120, BIG = 129;
const cyber = {};
for (let k = 0; k < 12; k++) {
  cyber['C' + k] = { name: 'サイバー' + k, bars: makeBars(800 + k * 150, (i) => {
    if (k === 0 && (i === X || i === X + 1)) return { lu: true, vm: 6 };
    if ((k === 1 || k === 2) && i === X + 5) return { r: 0.12, vm: 5 };
    if (i >= BIG && i <= BIG + 2 && k < 7) return k < 4 ? { lu: true, vm: 5, gap: 0.05 } : { r: 0.09, vm: 4, gap: 0.03 };
    if (i >= BIG && i <= BIG + 2 && k >= 7) return { r: 0.04, vm: 2.5 };
    if (i > BIG + 2 && i <= BIG + 8) return { r: 0.02 + noise(0.01), vm: 2 };
    if (i > BIG + 8 && i <= BIG + 14) return { r: -0.03, vm: 0.8 };
    return null;
  }) };
}
// 比較用：ずっと平常なテーマ
const calm = {};
for (let k = 0; k < 10; k++) calm['N' + k] = { name: '平常' + k, bars: makeBars(1200 + k * 100, () => null) };

const universe = [];
Object.keys(cyber).forEach(c => universe.push({ theme: 'サイバーセキュリティ', code: c }));
Object.keys(calm).forEach(c => universe.push({ theme: '平常テーマ', code: c }));
universe.push({ theme: 'サイバーセキュリティ', code: 'MISSING' });
const data = Object.assign({}, cyber, calm);

const an = R.analyze(universe, data, bench, { minTurnover: 0 });
const cy = an.themes['サイバーセキュリティ'];
const evs = cy.events.map(e => [e.i, e.type]);
console.log('サイバーのシグナル:', JSON.stringify(evs));
for (let i = X - 2; i <= BIG + 16; i++) {
  const d = cy.days[i];
  console.log(i, cy.stage[i].padEnd(4, '　'), 'heat', d.heat, 'base', d.base, 'hot5', d.hot5, 'ex20', d.ex20.toFixed(3));
}

const init = cy.events.find(e => e.type === '初動');
assert.ok(init, '初動が出る');
assert.ok(init.i >= X + 5 && init.i < BIG, '初動は急騰が3銘柄に広がった日で、一斉高（10/6相当）より前: ' + init.i);
assert.ok(!cy.events.some(e => e.i < X), '1銘柄が動く前には何も出ない');
assert.ok(!cy.events.some(e => e.type === '失速' && e.i < BIG), '一斉高の前の一服で失速を出さない');
assert.ok(cy.events.some(e => (e.type === '加速' || e.type === '過熱') && (e.i === BIG || e.i === BIG + 1)), '一斉高の日に加速か過熱が出る');
assert.ok(cy.events.some(e => e.type === '過熱' && e.i > init.i), '初動の後に過熱が出る');
assert.ok(cy.events.some(e => e.type === '失速' && e.i > BIG + 3), '熱が冷めたら失速が出る');
assert.strictEqual(cy.events.filter(e => e.type === '初動').length, 1, '初動は1回だけ');
assert.strictEqual(cy.codes.indexOf('MISSING'), -1, 'データのないコードは計算から外す');

// 平常テーマには「初動」が出ない
const cl = an.themes['平常テーマ'];
assert.ok(!cl.events.some(e => e.type === '初動'), '平常テーマに初動は出ない: ' + JSON.stringify(cl.events));

// 先読みをしていない：途中の日までのデータだけで計算しても、その日までの段階は同じ
function cut(obj, n) { const r = {}; for (const k in obj) r[k] = { name: obj[k].name, bars: obj[k].bars.slice(0, n) }; return r; }
const n2 = BIG + 1;
const an2 = R.analyze(universe, cut(data, n2), { bars: bench.bars.slice(0, n2) }, { minTurnover: 0 });
for (let i = 0; i < n2; i++) assert.strictEqual(an2.themes['サイバーセキュリティ'].stage[i], cy.stage[i], '先読みなし ' + i);

// 候補銘柄：一斉高の日は、S高の銘柄が先導株、まだ上がっていない銘柄が2番手候補
const cd = R.candidates(an, 'サイバーセキュリティ', BIG);
console.log('先導株', cd.leaders.map(x => x.code).join(','), '2番手', cd.next.map(x => x.code + ':' + x.score).join(','));
assert.ok(cd.leaders.some(x => x.code === 'C0' || x.code === 'C1'), '先にS高した銘柄が先導株');
cd.next.forEach(x => assert.ok(cd.leaders.every(l => l.code !== x.code), '先導株と2番手は重ならない'));

// 最新日のまとめと理由の文章
const lt = R.latest(R.analyze(universe, cut(data, BIG + 1), { bars: bench.bars.slice(0, BIG + 1) }, { minTurnover: 0 }));
const top = lt.rows[0];
assert.strictEqual(top.theme, 'サイバーセキュリティ');
assert.ok(['加速', '過熱', '上昇中'].indexOf(top.stage) >= 0, '一斉高の日は上位に来る: ' + top.stage);
assert.strictEqual(JSON.stringify(top.missing), '["MISSING"]', '取れなかったコードを知らせる');
console.log('理由:', R.reason(top.day));

// バックテスト：初動の後はテーマが市場より上がっている（合成データなので向きだけ確認）
const bt = R.backtest(an, [5, 10]);
console.log('バックテスト 初動:', JSON.stringify(bt.summary['初動']));
assert.ok(bt.summary['初動'].theme_5.avg > 0, '合成データでは初動の後に上がる');
assert.ok(bt.baseline[5].n > 0);
// 翌日の始値で買う前提：最終日のシグナルは成績に入らない
const anLast = R.analyze(universe, cut(data, BIG + 1), { bars: bench.bars.slice(0, BIG + 1) }, { minTurnover: 0 });
const btLast = R.backtest(anLast, [5]);
btLast.list.filter(r => r.date === dates[BIG]).forEach(r => assert.strictEqual(r.theme_[5], null, '未来のない日は null'));

console.log('OK engine.test.js');
