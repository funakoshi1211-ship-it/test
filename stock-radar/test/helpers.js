// テスト用の共通部品：Logic.gs と Defaults.gs を読み込み、乱数で架空の相場を作る
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { console };
vm.createContext(ctx);
for (const f of ['Logic.gs', 'Defaults.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx);
vm.runInContext('this.Radar = Radar; this.DEFAULT_MEMBERS = DEFAULT_MEMBERS; this.DEFAULT_NEWS = DEFAULT_NEWS;', ctx);
const plain = x => JSON.parse(JSON.stringify(x));   // vm の中で作った配列を、比べられる形にする

// ---------- 架空の相場 ----------
function rng(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bizDays(start, n) {
  const out = [], d = new Date(start + 'T00:00:00Z');
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const THEMES = ['銀行', '商社', '海運', '自動車', '不動産', 'サイバー'];
// shock(i, themeIdx, k) → { ret: 足すリターン, vol: 出来高の倍率, mkt: 市場全体に足すリターン }
function makeMarket(n, seed, shock) {
  const r = rng(seed), g = () => { const u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const dates = bizDays('2025-06-02', n), members = [], bars = {};
  let b = 2000; const bench = [];
  const mret = [];
  for (let i = 0; i < n; i++) {
    const s = (shock && shock(i, -1, -1)) || {};
    mret.push(0.0002 + 0.009 * g() + (s.mkt || 0));
    b *= 1 + mret[i];
    bench.push({ date: dates[i], close: b, price: b, volume: 1e7 });
  }
  bars['1306.T'] = bench;
  THEMES.forEach((th, ti) => {
    const tf = Array.from({ length: n }, () => 0.006 * g());
    for (let k = 0; k < 8; k++) {
      const code = String(1000 + ti * 10 + k), sym = code + '.T';
      members.push({ theme: th, code, name: th + k });
      let c = 1000; const base = 1e5 * (1 + k), out = [];
      for (let i = 0; i < n; i++) {
        const s = (shock && shock(i, ti, k)) || {};
        c *= 1 + mret[i] + tf[i] + 0.018 * g() + (s.ret || 0);
        out.push({ date: dates[i], close: c, price: c, volume: Math.round(base * Math.exp(0.3 * g()) * (s.vol || 1)) });
      }
      bars[sym] = out;
    }
  });
  return { dates, members, bars };
}
function cut(bars, upto) {
  const out = {};
  Object.keys(bars).forEach(s => { out[s] = bars[s].slice(0, upto + 1); });
  return out;
}

module.exports = { R: ctx.Radar, DEFAULT_MEMBERS: ctx.DEFAULT_MEMBERS, DEFAULT_NEWS: ctx.DEFAULT_NEWS, plain, THEMES, makeMarket, cut };
