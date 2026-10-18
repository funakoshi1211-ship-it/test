// Code.gs を、スプレッドシート・通信・メールの簡易な代役で通しで動かす
// （初期設定 → 今すぐ更新 → 毎日の自動更新 → メール → 検証、取得失敗、土日、ニュース件数）
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const { DEFAULT_MEMBERS } = require('./helpers');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok', name); }

// ---------- スプレッドシートの代役 ----------
function chain(base) {
  const p = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => p) });   // 書式の設定などは何もせず自分を返す
  return p;
}
function makeSheet(name) {
  let data = [];
  const sh = {
    getName: () => name,
    getLastRow: () => { for (let r = data.length; r > 0; r--) if ((data[r - 1] || []).some(v => v !== '' && v != null)) return r; return 0; },
    clear: () => { data = []; },
    setFrozenRows() {}, setFrozenColumns() {}, setColumnWidth() {},
    appendRow(row) { data[sh.getLastRow()] = row.slice(); },
    cell: (r, c) => ((data[r - 1] || [])[c - 1]),
    rows: () => data.map(r => (r || []).slice()),
    getRange(r, c, nr, nc) {
      if (typeof r === 'string') return chain({});   // 'B:B' など列全体は書式だけ
      nr = nr || 1; nc = nc || 1;
      assert.ok(r >= 1 && c >= 1 && nr >= 1 && nc >= 1, name + ' の範囲が不正 ' + [r, c, nr, nc]);
      const put = (i, j, v) => { data[r - 1 + i] = data[r - 1 + i] || []; data[r - 1 + i][c - 1 + j] = v; };
      return chain({
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (data[r - 1 + i] || [])[c - 1 + j]; return v == null ? '' : v; })),
        setValues: (v) => {
          assert.strictEqual(v.length, nr, name + ' の行数が合わない');
          v.forEach(row => {
            assert.strictEqual(row.length, nc, name + ' の列数が合わない');
            row.forEach(x => assert.ok(x !== undefined && !(typeof x === 'number' && !isFinite(x)), name + ' に書けない値 ' + x));
          });
          v.forEach((row, i) => row.forEach((x, j) => put(i, j, x)));
          return chain({});
        },
        setValue: (x) => { put(0, 0, x); return chain({}); },
        clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) put(i, j, ''); return chain({}); }
      });
    }
  };
  return sh;
}

// ---------- 架空の株価（銘柄ごとに決まった乱数） ----------
function rng(seed) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DATES = (() => {
  const out = [], d = new Date('2024-09-02T00:00:00Z');
  while (d.toISOString().slice(0, 10) <= '2026-10-16') {
    if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
})();
const CYBER = DEFAULT_MEMBERS.filter(r => r[0] === 'サイバーセキュリティ').map(r => r[1] + '.T');
const series = {};
function barsOf(sym) {
  if (series[sym]) return series[sym];
  let h = 0;
  for (const ch of sym) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const r = rng(h), g = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const hot = CYBER.indexOf(sym), n = DATES.length;
  let c = 1000;
  return (series[sym] = DATES.map((date, i) => {
    const jump = hot >= 0 && hot < 4 && i >= n - 2;   // サイバーの4銘柄が最後の2日に出来高4倍で急騰
    c *= 1 + 0.015 * g() + (jump ? 0.08 : 0);
    return { date, close: c, price: Math.round(c), volume: Math.round(1e5 * Math.exp(0.3 * g()) * (jump ? 4 : 1)) };
  }));
}
function yahooJson(bars) {
  return JSON.stringify({ chart: { result: [{
    meta: { gmtoffset: 32400 },
    timestamp: bars.map(b => Date.parse(b.date + 'T00:00:00Z') / 1000),
    indicators: { quote: [{ close: bars.map(b => b.price), volume: bars.map(b => b.volume) }], adjclose: [{ adjclose: bars.map(b => b.close) }] }
  }], error: null } });
}

// ---------- GAS の代役 ----------
let NOW = Date.parse('2026-10-16T09:00:00Z');   // 金曜 18:00（東京）
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const sheets = {}, order = [], mails = [], alerts = [], props = {};
let fetchMode = 'ok', fetchCount = 0, newsCount = 8;
const ss = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => { sheets[n] = makeSheet(n); order.push(n); return sheets[n]; },
  getSheets: () => order.map(n => sheets[n]),
  deleteSheet: sh => { delete sheets[sh.getName()]; order.splice(order.indexOf(sh.getName()), 1); },
  toast() {}, setActiveSheet() {},
  getUrl: () => 'https://docs.google.com/spreadsheets/d/xxx'
};
ss.insertSheet('シート1');
function pad(n) { return String(n).padStart(2, '0'); }
const ctx = {
  console,
  Date: FakeDate,
  SpreadsheetApp: { getActive: () => ss, getUi: () => ({ alert: m => alerts.push(m), createMenu: () => chain({}) }) },
  UrlFetchApp: {
    fetchAll: reqs => reqs.map(q => {
      fetchCount++;
      const m = q.url.match(/chart\/([^?]+)\?range=(\w+)/);
      if (fetchMode === 'fail') return { getResponseCode: () => 429, getContentText: () => 'Too Many Requests' };
      if (!m) return { getResponseCode: () => 200, getContentText: () => '<rss>' + '<item>x</item>'.repeat(newsCount) + '</rss>' };
      const sym = decodeURIComponent(m[1]);
      if (sym === '9999.T') return { getResponseCode: () => 404, getContentText: () => '{}' };
      const all = barsOf(sym), bars = m[2] === '1y' ? all.slice(-245) : all;
      return { getResponseCode: () => 200, getContentText: () => yahooJson(bars) };
    })
  },
  Utilities: {
    sleep() {},
    formatDate(d, tz, fmt) {
      const t = new Date(d.getTime() + 9 * 3600000);   // 東京時間
      const Y = t.getUTCFullYear(), M = t.getUTCMonth() + 1, D = t.getUTCDate(), h = t.getUTCHours(), mi = t.getUTCMinutes();
      return fmt.replace('yyyy', Y).replace('MM', pad(M)).replace('dd', pad(D)).replace('M/d', M + '/' + D)
        .replace('HH', pad(h)).replace('mm', pad(mi)).replace(/^u$/, String(t.getUTCDay() || 7));
    }
  },
  LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  PropertiesService: { getDocumentProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  MailApp: { sendEmail: o => mails.push(o) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => chain({}), deleteTrigger() {} }
};
vm.createContext(ctx);
// 貼り付けるもの（dist/Code.gs）と同じ、3ファイルをまとめたものを動かす
const { bundle } = require('../tools/build');
vm.runInContext(bundle(), ctx, { filename: 'dist/Code.gs' });
const run = name => vm.runInContext(name + '()', ctx);

// ---------- テスト ----------
test('初期設定でシートと初期データができる', () => {
  run('setup');
  ['ダッシュボード', '銘柄の動き', 'テーマ銘柄', 'ニュース語', '設定', '検証', 'ニュース件数', '通知ログ'].forEach(n => assert.ok(sheets[n], n));
  assert.ok(!sheets['シート1'], '空の「シート1」は消す');
  assert.strictEqual(order[0], 'ダッシュボード');
  assert.strictEqual(sheets['テーマ銘柄'].getLastRow(), DEFAULT_MEMBERS.length + 1);
  assert.strictEqual(sheets['設定'].cell(2, 1), '通知先メール');
  run('setup');   // 2回目でもデータを重ねない
  assert.strictEqual(sheets['テーマ銘柄'].getLastRow(), DEFAULT_MEMBERS.length + 1);
});

test('「今すぐ更新」でダッシュボードと銘柄の一覧ができる（メールは送らない）', () => {
  // テーマ欄を空けた行（上と同じテーマ）と、存在しないコードを足す
  const mem = sheets['テーマ銘柄'];
  mem.appendRow(['', '9999', '架空の銘柄']);
  run('updateNow');
  const dash = sheets['ダッシュボード'];
  assert.ok(/データの日付：2026-10-16/.test(dash.cell(1, 3)), dash.cell(1, 3));
  assert.strictEqual(dash.cell(3, 1), '状態');
  assert.strictEqual(dash.cell(4, 2), 'サイバーセキュリティ', '初動のテーマが一番上');
  assert.strictEqual(dash.cell(4, 1), '初動');
  assert.ok(/^=SPARKLINE\(SPLIT\("[\d ]+"," "\)/.test(dash.cell(4, 4)), dash.cell(4, 4));
  assert.ok(dash.rows().some(r => /9999\.T（コードが見つからない）/.test(r[0] || '')), '取得できなかった銘柄を書く');
  const st = sheets['銘柄の動き'];
  assert.strictEqual(st.cell(2, 1), 'サイバーセキュリティ');
  assert.ok(/急騰|出来高急増/.test(st.cell(2, 12)), st.cell(2, 12));
  assert.ok(st.rows().some(r => r[1] === '9999' && /データなし/.test(r[11])));
  assert.strictEqual(mails.length, 0);
  assert.ok(sheets['熱量の推移'].getLastRow() > 10);
});

test('毎日の自動更新：合図が出たらメールし、同じ日には二度送らない', () => {
  run('runDaily');
  assert.strictEqual(mails.length, 1);
  assert.ok(/^【初動】サイバーセキュリティ/.test(mails[0].subject), mails[0].subject);
  assert.strictEqual(mails[0].to, 'me@example.com');
  assert.ok(/docs\.google\.com/.test(mails[0].htmlBody));
  assert.ok(sheets['通知ログ'].rows().some(r => r[2] === 'サイバーセキュリティ' && r[3] === '初動'));
  run('runDaily');
  assert.strictEqual(mails.length, 1);
});

test('通知先メールの設定と、試しのメール', () => {
  const set = sheets['設定'];
  set.getRange(2, 2).setValue('other@example.com');
  run('testMail');
  assert.strictEqual(mails.length, 2);
  assert.strictEqual(mails[1].to, 'other@example.com');
});

test('設定に数字でない値が入っていても、初期値で動く', () => {
  const set = sheets['設定'];
  const row = set.rows().findIndex(r => r[0] === '初動の熱量') + 1;
  set.getRange(row, 2).setValue('六十');
  const cfg = vm.runInContext('readSettings_()', ctx);
  assert.strictEqual(cfg.igniteScore, 60);
  assert.strictEqual(cfg.hotDev25, 0.2);
  assert.deepStrictEqual(Array.from(cfg.notify), ['初動', '予兆', '過熱']);
  set.getRange(row, 2).setValue(65);
  assert.strictEqual(vm.runInContext('readSettings_()', ctx).igniteScore, 65);
  set.getRange(row, 2).setValue(60);
});

test('土日は自動更新しない', () => {
  NOW = Date.parse('2026-10-17T09:00:00Z');
  const before = fetchCount;
  run('runDaily');
  assert.strictEqual(fetchCount, before);
  NOW = Date.parse('2026-10-16T09:00:00Z');
});

test('ニュース件数をため、普段との比を出す', () => {
  const log = sheets['ニュース件数'];
  const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'];
  days.forEach(d => { NOW = Date.parse(d + 'T09:00:00Z'); newsCount = 8; run('updateNow'); });
  NOW = Date.parse('2026-10-16T09:00:00Z');
  newsCount = 40;
  run('updateNow');
  const rows = log.rows().slice(1).filter(r => r[1] === 'サイバーセキュリティ');
  assert.deepStrictEqual(rows.map(r => r[0]), days.concat(['2026-10-16']), '1日1行（同じ日は上書き）');
  const dash = sheets['ダッシュボード'];
  const cyber = dash.rows().find(r => r[1] === 'サイバーセキュリティ');
  assert.ok(/40件（普段の5\.0倍）/.test(cyber[11]), cyber[11]);
  newsCount = 120;
  run('updateNow');
  assert.ok(/100件以上/.test(dash.rows().find(r => r[1] === 'サイバーセキュリティ')[11]));
});

test('過去の検証を書き出す', () => {
  run('runBacktest');
  const bt = sheets['検証'];
  assert.strictEqual(bt.cell(4, 1), '区分');
  assert.strictEqual(bt.cell(7, 1), '参考：全期間の平均（合図と関係なく）');
  assert.ok(bt.cell(7, 2) > 1000, '全期間の件数 ' + bt.cell(7, 2));
  assert.strictEqual(bt.cell(9, 1), '日付');
  assert.ok(bt.rows().slice(9).some(r => r[1] === 'サイバーセキュリティ' && r[2] === '初動' && r[0] === '2026-10-16'));
});

test('株価をほとんど取得できない日は、そのことを1日1回だけ知らせる', () => {
  fetchMode = 'fail';
  props.lastMailDate = '';
  const before = mails.length;
  run('runDaily');
  run('runDaily');
  assert.strictEqual(mails.length, before + 1);
  assert.ok(/取得できませんでした/.test(mails[mails.length - 1].subject));
  run('updateNow');
  assert.ok(/ほとんど取得できませんでした/.test(alerts[alerts.length - 1]));
  fetchMode = 'ok';
});

test('貼り付け用の dist/ が gas/ と同じ（違うときは node tools/build.js）', () => {
  const dist = path.join(__dirname, '..', 'dist');
  assert.strictEqual(fs.readFileSync(path.join(dist, 'Code.gs'), 'utf8'), bundle());
  assert.strictEqual(fs.readFileSync(path.join(dist, 'appsscript.json'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'gas', 'appsscript.json'), 'utf8'));
});

console.log(passed, 'tests passed');
