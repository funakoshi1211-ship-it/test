// Code.gs を GAS の簡易な代役で動かし、取得 → 判定 → シート書き出しの流れを確かめる
//   node theme-radar/test/gas.test.js
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const dir = path.join(__dirname, '..', 'gas');

// ---- シートの代役 ----
function makeSheet(name) {
  let data = [];
  const sh = {
    name,
    data: () => data,
    getLastRow: () => data.length,
    clear() { data = []; return sh; },
    setFrozenRows() {}, setColumnWidth() {},
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      const rg = {
        setValues(v) {
          assert.strictEqual(v.length, nr, name + ' の行数が合わない');
          v.forEach((row, i) => {
            assert.strictEqual(row.length, nc, name + ' の列数が合わない');
            while (data.length < r + i) data.push([]);
            row.forEach((x, j) => { data[r - 1 + i][c - 1 + j] = x; });
          });
          return rg;
        },
        setValue(x) { return rg.setValues([[x]]); },
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((data[r - 1 + i] || [])[c - 1 + j] ?? ''))),
        getDisplayValues: () => rg.getValues().map(row => row.map(x => String(x))),
        setNumberFormat() { return rg; }, setFontWeight() { return rg; }
      };
      return rg;
    }
  };
  return sh;
}
const sheets = {}, order = [];
const ss = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => { sheets[n] = makeSheet(n); order.push(n); return sheets[n]; },
  getSheets: () => order.map(n => sheets[n]),
  deleteSheet: s => { delete sheets[s.name]; order.splice(order.indexOf(s.name), 1); },
  setActiveSheet() {}, moveActiveSheet() {}, getUrl: () => 'https://docs.google.com/spreadsheets/d/test'
};
ss.insertSheet('シート1');

// ---- 株価の代役（Yahoo の chart API と同じ形の JSON を返す） ----
let seed = 11;
function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
const NOW = new Date('2026-10-29T08:00:00Z'); // 日本時間 17:00
const days = [];
for (let d = new Date('2025-10-01T00:00:00Z'); d <= new Date('2026-10-29T00:00:00Z'); d = new Date(d.getTime() + 86400000)) {
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d);
}
const prices = {};
function series(code) {
  if (prices[code]) return prices[code];
  let c = 500 + Math.floor(rnd() * 3000);
  const cyber = ['4493', '153A', '338A', '4288', '3967', '3042'].indexOf(code);
  const rows = days.map((d, i) => {
    const left = days.length - 1 - i;
    let r = (rnd() - 0.5) * 0.02, vm = 1 + (rnd() - 0.5) * 0.4;
    if (cyber >= 0 && left <= 1) { r = 0.12; vm = 5; }   // 最後の2日、サイバーの6銘柄が急騰
    c = Math.max(50, Math.round(c * (1 + r)));
    return { ts: Math.floor(d.getTime() / 1000) + 6 * 3600, o: c, h: c, l: c, c, v: Math.round(200000 * vm) };
  });
  prices[code] = rows;
  return rows;
}
const BAD = '9999';
let fetchCount = 0;
const UrlFetchApp = {
  fetchAll(reqs) {
    return reqs.map(q => {
      fetchCount++;
      const m = q.url.match(/chart\/([^?]+)\.T\?range=(\w+)/);
      const code = decodeURIComponent(m[1]);
      if (code === BAD) return { getResponseCode: () => 404, getContentText: () => '' };
      const rows = series(code);
      const body = { chart: { result: [{ meta: { longName: 'Company ' + code }, timestamp: rows.map(x => x.ts),
        indicators: { quote: [{ open: rows.map(x => x.o), high: rows.map(x => x.h), low: rows.map(x => x.l), close: rows.map(x => x.c), volume: rows.map(x => x.v) }],
          adjclose: [{ adjclose: rows.map(x => x.c) }] } }] } };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
    });
  }
};

function formatDate(d, tz, fmt) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
}
const mails = [], triggers = [];
const trig = { timeBased: () => trig, everyDays: () => trig, atHour: h => { trig.h = h; return trig; }, nearMinute: () => trig, inTimezone: () => trig, create: () => { triggers.push(trig.h); } };
const ctx = {
  console,
  SpreadsheetApp: { getActive: () => ss, getUi: () => { throw new Error('no ui'); } },
  UrlFetchApp,
  Utilities: { formatDate, sleep() {} },
  ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => trig },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
  MailApp: { sendEmail: (to, subj, body) => mails.push({ to, subj, body }) }
};
vm.createContext(ctx);
['Engine.gs', 'Themes.gs', 'Code.gs'].forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx));
vm.runInContext('now_ = function () { return new Date(' + NOW.getTime() + '); };', ctx);

// ---- 初期設定 ----
vm.runInContext('setup()', ctx);
assert.ok(!sheets['シート1'], '空のシート1は消す');
assert.strictEqual(order[0], '通知用', '通知用が1枚目');
assert.strictEqual(JSON.stringify(triggers), '[16,17]', '16時台と17時台の自動実行');
const th = sheets['テーマ'].data();
assert.ok(th.length > 150, 'テーマの銘柄が入る: ' + th.length);
assert.ok(th.some(r => r[0] === 'サイバーセキュリティ' && r[1] === '153A' && r[2] === 'カウリス'));
assert.ok(th.some(r => r[1] === '3993' && r[2] === 'PKSHA Technology'), '名前の中の空白で区切られない');
th.push(['サイバーセキュリティ', BAD, 'でたらめ', '', '', '']);   // 誤ったコードを1つ混ぜる
// 「GASからもメールする」を「はい」にする
sheets['設定'].data().forEach(r => { if (r[0] === 'GASからもメールする') r[1] = 'はい'; });

// ---- 毎日の実行 ----
vm.runInContext('runDaily()', ctx);
const notice = sheets['通知用'].data();
const nv = Object.fromEntries(notice.filter(r => r[0]).map(r => [r[0], r[1]]));
console.log('通知用:', nv['状態'], nv['対象の取引日'], nv['アラート件数']);
assert.strictEqual(nv['対象の取引日'], '2026-10-29');
assert.strictEqual(nv['状態'], '新しいアラートあり');
assert.ok(String(nv['取得できないコード']).indexOf(BAD) >= 0, '取れないコードを書く');
const alertRows = sheets['アラート'].data().slice(1);
console.log('アラート:', alertRows.map(r => r[1] + ':' + r[2]).join(' / '));
const cy = alertRows.find(r => r[1] === 'サイバーセキュリティ');
assert.ok(cy && ['初動', '加速', '予兆'].indexOf(cy[2]) >= 0, 'サイバーにアラート');
assert.ok(cy[5] || cy[6], '候補銘柄が入る');
console.log('理由:', cy[4]);
console.log('先導株:', cy[5], '／2番手:', cy[6]);
const badRow = sheets['テーマ'].data().find(r => r[1] === BAD);
assert.ok(String(badRow[4]).indexOf('取得できません') === 0, '状態列に取得できないと出る');
const okRow = sheets['テーマ'].data().find(r => r[1] === '4493');
assert.strictEqual(okRow[3], 'Company 4493');
assert.strictEqual(okRow[4], 'OK');
const sig = sheets['シグナル'].data();
assert.strictEqual(sig[2][0], 'サイバーセキュリティ', 'シグナルの先頭は動いているテーマ');
assert.ok(sheets['候補銘柄'].data().length > 1);
assert.strictEqual(mails.length, 1, 'GASのメールは1通');
assert.ok(mails[0].subj.indexOf('サイバーセキュリティ') >= 0);
const histN = sheets['履歴'].data().length;

// 17時台にもう一度動いても、同じ日の記録は増えない
vm.runInContext('runDaily()', ctx);
assert.strictEqual(sheets['アラート'].data().length, alertRows.length + 1, 'アラートは二重に書かない');
assert.strictEqual(sheets['履歴'].data().length, histN, '履歴は二重に書かない');

// 休場日（翌日の土曜）は「今日の取引データなし」でアラートを出さない
vm.runInContext('now_ = function () { return new Date(' + new Date('2026-10-31T08:00:00Z').getTime() + '); };', ctx);
vm.runInContext('runDaily()', ctx);
const nv2 = Object.fromEntries(sheets['通知用'].data().filter(r => r[0]).map(r => [r[0], r[1]]));
assert.ok(nv2['状態'].indexOf('今日の取引データなし') === 0);
assert.strictEqual(nv2['アラート件数'], 0);

// 取引時間中（10/29 の 11:00）に動かしたら、確定していない当日の足は使わない
vm.runInContext('now_ = function () { return new Date(' + new Date('2026-10-29T02:00:00Z').getTime() + '); };', ctx);
vm.runInContext('runDaily()', ctx);
const nv3 = Object.fromEntries(sheets['通知用'].data().filter(r => r[0]).map(r => [r[0], r[1]]));
assert.strictEqual(nv3['対象の取引日'], '2026-10-28', '取引時間中は前日までで計算');

// バックテスト
vm.runInContext('runBacktest()', ctx);
const bt = sheets['バックテスト'].data();
assert.ok(bt.length >= 3 + 15, 'バックテストの表ができる');
console.log('バックテスト先頭:', JSON.stringify(bt[2]));
console.log('取得回数', fetchCount);
console.log('OK gas.test.js');
