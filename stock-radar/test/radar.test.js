// 判定ロジック（Logic.gs）のテスト。乱数で作った架空の相場に「テーマの初動」を仕込み、
// その日までのデータだけで気づけるか、はずれの合図が多すぎないかを確かめる
const assert = require('assert');
const { R, DEFAULT_MEMBERS, DEFAULT_NEWS, plain, THEMES, makeMarket, cut } = require('./helpers');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok', name); }

const N = 330, T = 300, CY = THEMES.indexOf('サイバー');
// サイバー：T日目から3銘柄が出来高4倍で急騰、2日遅れて3銘柄が続く（10月のサイバーセキュリティ株のような動き）
const cyber = (i, ti, k) => {
  if (ti !== CY) return null;
  if (k < 3 && i >= T && i < T + 3) return { ret: [0.12, 0.08, 0.06][k], vol: 4 };
  if (k >= 3 && k < 6 && i >= T + 2 && i < T + 6) return { ret: 0.04, vol: 2.5 };
  return null;
};
const M = makeMarket(N, 7, cyber);

// ---------- テスト ----------
test('証券コードを Yahoo の記号にする', () => {
  assert.strictEqual(R.toSymbol(4493), '4493.T');
  assert.strictEqual(R.toSymbol('153a'), '153A.T');
  assert.strictEqual(R.toSymbol('４４９３'), '4493.T');
  assert.strictEqual(R.toSymbol(' CRWD '), 'CRWD');
  assert.strictEqual(R.toSymbol('1306.T'), '1306.T');
  assert.strictEqual(R.marketOf('4493.T'), 'JP');
  assert.strictEqual(R.marketOf('CRWD'), 'US');
});

test('Yahoo の応答を読む（欠けた値・同じ日付の足・時差）', () => {
  const ts = d => Date.parse(d + 'T00:00:00Z') / 1000;   // 東京 9:00 = UTC 0:00
  const json = JSON.stringify({ chart: { result: [{
    meta: { gmtoffset: 32400 },
    timestamp: [ts('2026-10-01'), ts('2026-10-02'), ts('2026-10-05'), ts('2026-10-05') + 3600],
    indicators: { quote: [{ close: [100, null, 110, 112], volume: [1000, 0, 3000, 3500] }], adjclose: [{ adjclose: [99, null, 110, null] }] }
  }], error: null } });
  const b = R.parseYahooChart(json);
  assert.deepStrictEqual(plain(b.map(x => x.date)), ['2026-10-01', '2026-10-05']);
  assert.strictEqual(b[0].close, 99);
  assert.strictEqual(b[0].price, 100);
  assert.strictEqual(b[1].close, 112);       // 後から来た足（取引中の足）を使う
  assert.strictEqual(b[1].volume, 3500);
  assert.deepStrictEqual(plain(R.parseYahooChart('{"chart":{"result":null,"error":{"code":"Not Found"}}}')), []);
  assert.deepStrictEqual(plain(R.parseYahooChart('<html>')), []);
});

test('テーマの初動に、動き始めて2日以内に気づく（その日までのデータだけで判定）', () => {
  let first = -1;
  for (let i = T - 40; i <= T + 3 && first < 0; i++) {
    const res = R.analyze({ members: M.members, bars: cut(M.bars, i) });
    const a = res.alerts.find(x => x.theme === 'サイバー' && x.stage === '初動');
    if (a) first = i;
  }
  console.log('   初動の合図:', first - T, '営業日目（0＝動き始めた日）');
  assert.ok(first >= T && first <= T + 1, '初動が ' + (first - T) + ' 営業日目');
  const res = R.analyze({ members: M.members, bars: cut(M.bars, first) });
  const row = res.themes[0];
  assert.strictEqual(row.theme, 'サイバー');   // 初動がいちばん上に並ぶ
  assert.ok(row.leaders[0].startsWith('サイバー0'), row.leaders.join());
  assert.ok(/出来高急増/.test(row.reason), row.reason);
});

test('先の値を使っていない（全期間で計算しても、その日までで計算しても同じ判定）', () => {
  const full = R.analyze({ members: M.members, bars: M.bars }).backtest.events;
  for (const i of [T - 20, T, T + 1, T + 4]) {
    const part = R.analyze({ members: M.members, bars: cut(M.bars, i) }).backtest.events;
    const d = M.dates[i];
    const key = e => e.date + e.theme + e.stage + e.score;
    assert.deepStrictEqual(plain(part.map(key)), plain(full.filter(e => e.date <= d).map(key)), d);
  }
});

test('過去の検証：初動のあとのテーマの値動きと、全期間の平均を出す', () => {
  const bt = R.analyze({ members: M.members, bars: M.bars }).backtest;
  const ev = bt.events.find(e => e.theme === 'サイバー' && e.stage === '初動');
  assert.ok(ev && (ev.date === M.dates[T] || ev.date === M.dates[T + 1]), JSON.stringify(ev));
  assert.ok(ev.f5 > 0, '初動のあと5日の値動き ' + ev.f5);
  assert.ok(bt.ignite.count >= 1 && bt.baseline.count > 1000);
  assert.ok(bt.baseline.win10 > 0.3 && bt.baseline.win10 < 0.7, '全期間の勝率 ' + bt.baseline.win10);
});

test('何も起きていない相場では、初動の合図はほとんど出ない', () => {
  let ignites = 0, days = 0;
  for (const seed of [1, 2, 3]) {
    const res = R.analyze({ members: M.members, bars: makeMarket(N, seed).bars });
    ignites += res.backtest.events.filter(e => e.stage === '初動').length;
    days += (N - 70) * THEMES.length;
  }
  console.log('   はずれの初動:', ignites, '回 /', days, 'テーマ・日');
  assert.ok(ignites <= 3, 'はずれの初動が ' + ignites + ' 回');
});

test('1銘柄だけの急騰は、テーマの初動にしない', () => {
  const one = makeMarket(N, 11, (i, ti, k) => (ti === 0 && k === 0 && i >= T && i < T + 2) ? { ret: 0.15, vol: 6 } : null);
  for (let i = T; i <= T + 3; i++) {
    const res = R.analyze({ members: one.members, bars: cut(one.bars, i) });
    const bank = res.themes.find(r => r.theme === '銀行');
    assert.notStrictEqual(bank.stage, '初動', one.dates[i] + ' 熱量 ' + bank.score);
  }
});

test('暴落の日（全銘柄の出来高が増える日）は、出来高の合図にしない', () => {
  const crash = makeMarket(N, 5, (i) => i === T ? { mkt: -0.05, vol: 3.5 } : null);
  const res = R.analyze({ members: crash.members, bars: cut(crash.bars, T) });
  const noisy = res.themes.filter(r => r.stage === '初動' || (r.stage === '予兆' && r.kind === 'volume'));
  assert.strictEqual(noisy.length, 0, noisy.map(r => r.theme + r.stage).join());
});

test('ニュースが急に増えたテーマは、株価が動く前でも「予兆」にする', () => {
  const quiet = makeMarket(N, 3);
  const res = R.analyze({ members: quiet.members, bars: quiet.bars, news: { '海運': { count: 30, ratio: 4.2 }, '銀行': { count: 3, ratio: 3 } } });
  const ship = res.themes.find(r => r.theme === '海運'), bank = res.themes.find(r => r.theme === '銀行');
  if (ship.stage === '') throw new Error('予兆にならない');
  if (ship.kind === 'news') assert.ok(/ニュースが普段の4\.2倍/.test(ship.reason), ship.reason);
  assert.notStrictEqual(bank.kind, 'news');   // 件数が少ないときは合図にしない
});

test('データが取れない銘柄・ベンチマークは一覧で返す', () => {
  const bars = Object.assign({}, M.bars);
  delete bars['1000.T'];
  delete bars['1306.T'];
  const res = R.analyze({ members: M.members, bars });
  assert.deepStrictEqual(plain(res.missing), ['1000.T']);
  assert.deepStrictEqual(plain(res.benchMissing), ['1306.T']);
  assert.ok(res.date, 'ベンチマークがなくても日付の軸を作る');
});

test('初期の銘柄リストのコードが正しい形', () => {
  const seen = {};
  DEFAULT_MEMBERS.forEach(([th, code, name]) => {
    assert.ok(th && name, code);
    assert.ok(/^\d{3}[0-9A-Z]$/.test(code), code + ' ' + name);
    const key = th + code;
    assert.ok(!seen[key], '重複 ' + th + ' ' + code);
    seen[key] = 1;
  });
  const themes = new Set(DEFAULT_MEMBERS.map(r => r[0]));
  themes.forEach(th => assert.ok(DEFAULT_MEMBERS.filter(r => r[0] === th).length >= 4, th + ' の銘柄が少ない'));
  DEFAULT_NEWS.forEach(([th]) => assert.ok(themes.has(th), 'ニュース語のテーマ ' + th + ' が銘柄リストにない'));
});

console.log(passed, 'tests passed');
