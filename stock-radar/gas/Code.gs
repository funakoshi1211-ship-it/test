/**
 * テーマレーダー（GAS 側）
 * 株価とニュース件数の取得、シートの読み書き、メール通知だけを担当する。
 * 判定は Logic.gs（Radar）で行う。
 *
 * @OnlyCurrentDoc  このスプレッドシートだけを読み書きする（他のスプレッドシートへの権限は求めない）
 */

var TZ = 'Asia/Tokyo';

var SHEETS = {
  dash: { name: 'ダッシュボード' },
  stocks: { name: '銘柄の動き' },
  hist: { name: '熱量の推移' },
  members: { name: 'テーマ銘柄', header: ['テーマ（空欄は上と同じ）', 'コード（日本株は4桁、米国株はティッカー）', '銘柄名'] },
  news: { name: 'ニュース語', header: ['テーマ', 'Googleニュースの検索語（OR でつなぐ）'] },
  settings: { name: '設定', header: ['項目', '値', '説明'] },
  backtest: { name: '検証' },
  newsLog: { name: 'ニュース件数', header: ['日付', 'テーマ', '件数'] },
  log: { name: '通知ログ', header: ['送信日時', 'データの日付', 'テーマ', '状態', '内容'] }
};

var SETTINGS = [
  { key: 'mailTo', label: '通知先メール', def: '', note: '空欄なら、このスクリプトを動かしている自分のアドレスに送る' },
  { key: 'daily', label: '毎日まとめを送る', def: 'いいえ', note: '「はい」なら合図がない日も送る。「いいえ」は合図が出た日だけ' },
  { key: 'notify', label: '通知する状態', def: '初動,予兆,過熱', note: 'カンマ区切り。初動／予兆／上昇中／過熱／失速' },
  { key: 'benchJP', label: 'ベンチマーク（日本株）', def: '1306.T', note: 'TOPIX連動ETF。小型株と比べたいときは 2516.T（グロース250連動ETF）' },
  { key: 'benchUS', label: 'ベンチマーク（米国株）', def: 'SPY', note: 'S&P500連動ETF（米国株を入れたときだけ使う）' },
  { key: 'igniteScore', label: '初動の熱量', def: 60, note: '熱量（0〜100）がこれ以上で「初動」「上昇中」。下げると早く多く出る（はずれも増える）' },
  { key: 'quietScore', label: '静かだった目安', def: 45, note: '3〜10営業日前の熱量がずっとこれ未満なら「動き始め」とみなす' },
  { key: 'watchRise', label: '予兆の上昇幅', def: 15, note: '熱量が5営業日でこれだけ上がったら「予兆」' },
  { key: 'hotDev25', label: '過熱の乖離率（%）', def: 20, note: 'テーマ平均で25日移動平均からこれ以上離れたら「過熱」' },
  { key: 'surgeVol', label: '出来高急増の倍率', def: 2, note: '当日の出来高が普段（60営業日平均）の何倍で「急増」とするか' },
  { key: 'minSurge', label: '初動に必要な銘柄数', def: 2, note: '出来高急増＋上昇がそろった銘柄がこの数以上で「初動」' },
  { key: 'hour', label: '自動更新の時刻（時）', def: 18, note: '東証が閉まったあと（16時以降）にする。変えたら「毎日の自動更新をオンにする」をもう一度' }
];

var STAGE_COLORS = { '初動': '#f4cccc', '予兆': '#fce5cd', '上昇中': '#fff2cc', '過熱': '#d9d2e9', '失速': '#eeeeee', '': '#ffffff' };
var LEGEND = '初動＝同じテーマの複数銘柄がそろって動き始めた　予兆＝その手前（熱量の急上昇・出来高先行・ニュース急増）　上昇中＝勢いが続いている　過熱＝上がりすぎ注意　失速＝勢いが落ちた';
var PCT = '+0.0%;-0.0%;0.0%';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('テーマレーダー')
    .addItem('今すぐ更新', 'updateNow')
    .addItem('過去の合図を検証（2年分）', 'runBacktest')
    .addSeparator()
    .addItem('毎日の自動更新をオンにする', 'installTrigger')
    .addItem('毎日の自動更新をオフにする', 'removeTrigger')
    .addItem('通知メールを試しに送る', 'testMail')
    .addSeparator()
    .addItem('初期設定（シートを作る）', 'setup')
    .addToUi();
}

// ---------- 初期設定 ----------
function setup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (k) {
    var def = SHEETS[k], sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    if (def.header && sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, def.header.length).setValues([def.header]).setFontWeight('bold').setBackground('#eef2f5');
      sh.setFrozenRows(1);
    }
  });
  seed_(SHEETS.settings.name, SETTINGS.map(function (s) { return [s.label, s.def, s.note]; }));
  seed_(SHEETS.members.name, DEFAULT_MEMBERS);
  seed_(SHEETS.news.name, DEFAULT_NEWS);
  ss.getSheetByName(SHEETS.members.name).getRange('B:B').setNumberFormat('@');   // 153A や 0 始まりのコードを文字のまま扱う
  ss.getSheetByName(SHEETS.newsLog.name).getRange('A:A').setNumberFormat('@');
  var first = ss.getSheetByName('シート1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
  ss.toast('シートを作りました。メニュー「テーマレーダー」→「今すぐ更新」を押してください。', 'テーマレーダー', 8);
}

function seed_(name, rows) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (sh.getLastRow() > 1 || !rows.length) return;
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

// ---------- 自動更新 ----------
function installTrigger() {
  removeTrigger_();
  var hour = Number(readSettings_().hour) || 18;
  ScriptApp.newTrigger('runDaily').timeBased().everyDays(1).atHour(hour).inTimezone(TZ).create();
  SpreadsheetApp.getActive().toast('毎日 ' + hour + ' 時ごろに更新します（土日は休み）。合図が出た日はメールでお知らせします。', 'テーマレーダー', 8);
}

function removeTrigger() {
  removeTrigger_();
  SpreadsheetApp.getActive().toast('自動更新をオフにしました。', 'テーマレーダー', 5);
}

function removeTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDaily') ScriptApp.deleteTrigger(t);
  });
}

// 毎日の自動更新（トリガーから呼ばれる）。メールを送るのはここだけ
function runDaily() {
  var dow = Utilities.formatDate(new Date(), TZ, 'u');
  if (dow === '6' || dow === '7') return;
  update_('auto');
}

// メニューから。日中に押すと、その日の途中の値で計算する。メールは送らない
function updateNow() {
  var res = update_('manual');
  if (res) SpreadsheetApp.getActive().toast('更新しました（データの日付：' + res.date + '）', 'テーマレーダー', 5);
}

function testMail() {
  var res = update_('test');
  if (res) SpreadsheetApp.getActive().toast('メールを送りました：' + mailTo_(readSettings_()), 'テーマレーダー', 5);
}

function update_(mode) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return null;
  try {
    var cfg = readSettings_(), members = readMembers_();
    if (!members.length) throw new Error('「テーマ銘柄」シートに銘柄がありません');
    var got = fetchBars_(symbolsFor_(members, cfg), '1y');
    var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    var news = updateNewsLog_(fetchNews_(readNewsTerms_()), today);
    var res = Radar.analyze({ members: members, bars: got.bars, news: news }, cfg);
    writeDashboard_(res, cfg, got.failed);
    writeStocks_(res, got.failed);
    writeHistory_(res);
    var ok = members.filter(function (m) { return got.bars[Radar.toSymbol(m.code)]; }).length;
    if (ok < members.length / 2) {
      // 黙って何も来ないと「合図がない」のか「壊れている」のか分からないので、取得失敗は知らせる
      if (mode !== 'manual') notifyFailure_(cfg, got.failed, today);
      if (mode === 'manual') SpreadsheetApp.getUi().alert('株価をほとんど取得できませんでした（' + ok + '/' + members.length + '銘柄）。時間をおいてもう一度試してください。');
      return null;
    }
    if (mode === 'auto') notify_(res, cfg, false);
    if (mode === 'test') notify_(res, cfg, true);
    return res;
  } finally {
    lock.releaseLock();
  }
}

// ---------- 過去の検証 ----------
function runBacktest() {
  var cfg = readSettings_(), members = readMembers_();
  var got = fetchBars_(symbolsFor_(members, cfg), '2y');
  var res = Radar.analyze({ members: members, bars: got.bars }, cfg);
  writeBacktest_(res);
  var ss = SpreadsheetApp.getActive();
  ss.setActiveSheet(ss.getSheetByName(SHEETS.backtest.name));
  ss.toast('過去の合図を「検証」シートに書き出しました。', 'テーマレーダー', 5);
}

// ---------- 読み込み ----------
function readSettings_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.settings.name);
  var vals = {}, cfg = {};
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) { vals[str_(r[0])] = r[1]; });
  }
  SETTINGS.forEach(function (s) {
    var v = vals[s.label];
    if (typeof s.def === 'number') v = isFinite(Number(v)) && str_(v) !== '' ? Number(v) : s.def;   // 数字でない値は初期値に戻す
    cfg[s.key] = v === '' || v == null ? s.def : v;
  });
  cfg.hotDev25 = cfg.hotDev25 / 100;
  cfg.notify = str_(cfg.notify).split(/[,、\s]+/).filter(String);
  cfg.daily = str_(cfg.daily) === 'はい';
  return cfg;
}

function readMembers_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.members.name);
  if (!sh || sh.getLastRow() < 2) return [];
  var theme = '';
  return sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().map(function (r) {
    theme = str_(r[0]) || theme;
    return { theme: theme, code: str_(r[1]), name: str_(r[2]) };
  }).filter(function (m) { return m.theme && m.code; });
}

function readNewsTerms_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.news.name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues()
    .map(function (r) { return { theme: str_(r[0]), query: str_(r[1]) }; })
    .filter(function (t) { return t.theme && t.query; });
}

function symbolsFor_(members, cfg) {
  var seen = {}, out = [];
  members.forEach(function (m) { seen[Radar.toSymbol(m.code)] = 1; });
  seen[Radar.toSymbol(cfg.benchJP)] = 1;
  if (members.some(function (m) { return Radar.marketOf(Radar.toSymbol(m.code)) === 'US'; })) seen[Radar.toSymbol(cfg.benchUS)] = 1;
  Object.keys(seen).forEach(function (s) { if (s) out.push(s); });
  return out;
}

// ---------- 取得 ----------
// Yahoo Finance の日足。混み合って断られた分（429 など）は、少し待って別のホストでやり直す
function fetchBars_(symbols, range) {
  var bars = {}, failed = {}, pending = symbols.slice();
  for (var round = 0; round < 3 && pending.length; round++) {
    if (round) Utilities.sleep(3000 * round);
    var host = round % 2 ? 'query2' : 'query1', retry = [];
    for (var i = 0; i < pending.length; i += 8) {
      var chunk = pending.slice(i, i + 8), res;
      try {
        res = UrlFetchApp.fetchAll(chunk.map(function (s) {
          return {
            url: 'https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?range=' + range + '&interval=1d&includeAdjustedClose=true',
            muteHttpExceptions: true,
            headers: { 'User-Agent': 'Mozilla/5.0' }
          };
        }));
      } catch (e) {
        chunk.forEach(function (s) { failed[s] = '通信エラー'; retry.push(s); });
        continue;
      }
      res.forEach(function (r, k) {
        var s = chunk[k], code = r.getResponseCode();
        if (code === 200) {
          var b = Radar.parseYahooChart(r.getContentText());
          if (b.length) { bars[s] = b; delete failed[s]; } else failed[s] = 'データなし';
        } else if (code === 404) {
          failed[s] = 'コードが見つからない';
        } else {
          failed[s] = '取得エラー（' + code + '）';
          retry.push(s);
        }
      });
      Utilities.sleep(300);
    }
    pending = retry;
  }
  return { bars: bars, failed: failed };
}

// Googleニュースの検索結果（直近24時間）の件数。1回で最大100件までしか返らない
function fetchNews_(terms) {
  var out = {};
  if (!terms.length) return out;
  try {
    var res = UrlFetchApp.fetchAll(terms.map(function (t) {
      return {
        url: 'https://news.google.com/rss/search?q=' + encodeURIComponent(t.query + ' when:1d') + '&hl=ja&gl=JP&ceid=JP:ja',
        muteHttpExceptions: true
      };
    }));
    res.forEach(function (r, i) {
      if (r.getResponseCode() === 200) out[terms[i].theme] = (r.getContentText().match(/<item>/g) || []).length;
    });
  } catch (e) {
    console.warn('ニュースを取得できませんでした: ' + e);
  }
  return out;
}

// 今日の件数を「ニュース件数」シートに残し、直近14日の平均と比べる（ためるほど比べられるようになる）
function updateNewsLog_(counts, today) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.newsLog.name), out = {};
  var themes = Object.keys(counts);
  if (!sh || !themes.length) return out;
  var oldest = Utilities.formatDate(new Date(Date.now() - 120 * 86400000), TZ, 'yyyy-MM-dd');
  var rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues() : [];
  rows = rows.map(function (r) { return [dateStr_(r[0]).slice(0, 10), str_(r[1]), Number(r[2]) || 0]; })
    .filter(function (r) { return r[0] >= oldest && !(r[0] === today && counts[r[1]] != null); });
  themes.forEach(function (th) {
    var prior = rows.filter(function (r) { return r[1] === th && r[0] < today; })
      .sort(function (a, b) { return a[0] < b[0] ? -1 : 1; }).slice(-14).map(function (r) { return r[2]; });
    var avg = prior.length ? prior.reduce(function (s, x) { return s + x; }, 0) / prior.length : 0;
    var c = counts[th];
    out[th] = { count: c, avg: avg, ratio: prior.length >= 3 && c < 100 ? c / Math.max(1, avg) : null };
    rows.push([today, th, c]);
  });
  rows.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 3).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, 3).setValues(rows);
  }
  return out;
}

// ---------- 書き出し ----------
function writeDashboard_(res, cfg, failed) {
  var sh = sheet_(SHEETS.dash.name);
  sh.clear();
  var head = ['状態', 'テーマ', '熱量', '30日の推移', '5日前', '5日 市場比', '20日 市場比', '出来高（普段比）', '高値更新', '市場より強い', '25日線乖離', 'ニュース（24時間）', 'よく動いた銘柄', 'ひとこと'];
  var rows = res.themes.map(function (r) {
    var f = r.f || {};
    return [r.stage, r.theme, nz_(r.score), sparkline_(r.spark), nz_(r.score5), nz_(f.x5), nz_(f.x20), nz_(f.vTop),
      f.n ? f.hi + '/' + f.n : '', f.n ? f.up + '/' + f.n : '', nz_(f.dev25), newsText_(r.news), r.leaders.join('、'), r.reason];
  });
  sh.getRange(1, 1).setValue('テーマレーダー').setFontSize(14).setFontWeight('bold');
  sh.getRange(1, 3).setValue('データの日付：' + res.date + '　更新：' + Utilities.formatDate(new Date(), TZ, 'M/d HH:mm') + '　比べる相手：' + cfg.benchJP);
  sh.getRange(2, 1).setValue(LEGEND).setFontColor('#666666');
  sh.getRange(3, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#eef2f5');
  if (rows.length) {
    sh.getRange(4, 1, rows.length, head.length).setValues(rows);
    sh.getRange(4, 6, rows.length, 2).setNumberFormat(PCT);
    sh.getRange(4, 8, rows.length, 1).setNumberFormat('0.0"倍"');
    sh.getRange(4, 11, rows.length, 1).setNumberFormat(PCT);
    sh.getRange(4, 1, rows.length, 2).setBackgrounds(res.themes.map(function (r) { var c = STAGE_COLORS[r.stage] || '#ffffff'; return [c, c]; }));
    sh.getRange(4, 1, rows.length, 1).setFontWeight('bold');
  }
  var notes = [], fl = Object.keys(failed || {});
  if (res.benchMissing.length) notes.push('ベンチマーク ' + res.benchMissing.join('、') + ' を取得できなかったので、市場比は「市場との差」ではなく値動きそのものです');
  if (fl.length) notes.push('取得できなかった銘柄：' + fl.map(function (s) { return s + '（' + failed[s] + '）'; }).join('、'));
  if (notes.length) sh.getRange(rows.length + 5, 1, notes.length, 1).setValues(notes.map(function (n) { return [n]; })).setFontColor('#a61c00');
  sh.setFrozenRows(3);
  sh.setColumnWidth(2, 150);
  sh.setColumnWidth(4, 120);
  sh.setColumnWidth(13, 280);
  sh.setColumnWidth(14, 360);
}

function writeStocks_(res, failed) {
  var sh = sheet_(SHEETS.stocks.name);
  sh.clear();
  var head = ['テーマ', 'コード', '銘柄名', '終値', '前日比', '5日騰落', '5日 市場比', '20日 市場比', '出来高（5日・普段比）', '出来高（当日・普段比）', '25日線乖離', '合図'];
  var order = {};
  res.themes.forEach(function (r, i) { order[r.theme] = i; });
  var list = res.stocks.slice().sort(function (a, b) {
    return order[a.theme] - order[b.theme] || (b.f ? b.f.z5 : -99) - (a.f ? a.f.z5 : -99);
  });
  var rows = list.map(function (s) {
    var f = s.f;
    if (!f) return [s.theme, s.code, s.name, '', '', '', '', '', '', '', '', 'データなし' + (failed && failed[s.symbol] ? '（' + failed[s.symbol] + '）' : '（上場から日が浅い・コード違いなど）')];
    return [s.theme, s.code, s.name, f.price, f.ret1, f.r5, f.x5, f.x20, nz_(f.rv5), nz_(f.rv1), f.dev25, s.flags.join('・')];
  });
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#eef2f5');
  if (rows.length) {
    sh.getRange(2, 1, rows.length, head.length).setValues(rows);
    sh.getRange(2, 2, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 4, rows.length, 1).setNumberFormat('#,##0.##');
    sh.getRange(2, 5, rows.length, 4).setNumberFormat(PCT);
    sh.getRange(2, 9, rows.length, 2).setNumberFormat('0.0"倍"');
    sh.getRange(2, 11, rows.length, 1).setNumberFormat(PCT);
  }
  sh.setFrozenRows(1);
  sh.setColumnWidth(3, 200);
  sh.setColumnWidth(12, 260);
}

function writeHistory_(res) {
  var sh = sheet_(SHEETS.hist.name);
  sh.clear();
  var head = ['テーマ'].concat(res.history.dates.map(function (d) { return d.slice(5).replace('-', '/'); }));
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#eef2f5');
  if (res.history.rows.length) sh.getRange(2, 1, res.history.rows.length, head.length).setValues(res.history.rows);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
}

function writeBacktest_(res) {
  var sh = sheet_(SHEETS.backtest.name), bt = res.backtest;
  sh.clear();
  sh.getRange(1, 1).setValue('過去の合図と、その後のテーマの値動き（ベンチマークとの差）').setFontSize(14).setFontWeight('bold');
  sh.getRange(2, 1).setValue('「その後○日」＝合図の日の終値から○営業日後までの、テーマの銘柄の平均（ベンチマークの値動きを引いたもの）。全期間の平均より良ければ、合図に意味があったと言える。銘柄は今のリストなので、あとから人気になったテーマほど良く見えやすい点に注意').setFontColor('#666666');
  var sum = [['区分', '件数', 'その後5日', 'その後10日', '10日後に市場を上回った割合', 'その後20日']];
  [['初動', bt.ignite], ['予兆', bt.watch], ['参考：全期間の平均（合図と関係なく）', bt.baseline]].forEach(function (x) {
    var s = x[1];
    sum.push([x[0], s.count, nz_(s.f5), nz_(s.f10), nz_(s.win10), nz_(s.f20)]);
  });
  sh.getRange(4, 1, sum.length, 6).setValues(sum);
  sh.getRange(4, 1, 1, 6).setFontWeight('bold').setBackground('#eef2f5');
  sh.getRange(5, 3, 3, 4).setNumberFormat(PCT);
  sh.getRange(5, 5, 3, 1).setNumberFormat('0%');
  var head = ['日付', 'テーマ', '状態', '熱量', 'その後5日', 'その後10日', 'その後20日', 'ひとこと'];
  var rows = bt.events.map(function (e) { return [e.date, e.theme, e.stage, e.score, nz_(e.f5), nz_(e.f10), nz_(e.f20), e.reason]; });
  sh.getRange(9, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#eef2f5');
  if (rows.length) {
    sh.getRange(10, 1, rows.length, head.length).setValues(rows);
    sh.getRange(10, 1, rows.length, 1).setNumberFormat('@');
    sh.getRange(10, 5, rows.length, 3).setNumberFormat(PCT);
    sh.getRange(10, 3, rows.length, 1).setBackgrounds(bt.events.map(function (e) { return [STAGE_COLORS[e.stage]]; }));
  }
  sh.setColumnWidth(1, 220);
  sh.setColumnWidth(2, 150);
  sh.setColumnWidth(8, 420);
}

// ---------- 通知 ----------
function notify_(res, cfg, force) {
  var props = PropertiesService.getDocumentProperties();
  if (!force && props.getProperty('lastMailDate') === res.date) return;   // 同じデータの日付では1回だけ
  var recent = recentAlerts_(7), alerts = res.alerts;
  if (!force) alerts = alerts.filter(function (a) { return !recent[a.theme + '|' + a.stage]; });
  if (!alerts.length && !cfg.daily && !force) return;
  var top = alerts.length ? alerts : res.themes.filter(function (r) { return r.score != null; }).slice(0, 5);
  var subject = alerts.length
    ? '【' + alerts[0].stage + '】' + alerts[0].theme + (alerts.length > 1 ? ' ほか' + (alerts.length - 1) + '件' : '') + '｜テーマレーダー'
    : 'きょうは目立った合図なし｜テーマレーダー';
  var url = SpreadsheetApp.getActive().getUrl();
  var html = '<p>データの日付：' + res.date + '</p>' +
    '<table cellpadding="6" style="border-collapse:collapse;font-size:14px">' +
    '<tr style="background:#eef2f5"><th>状態</th><th>テーマ</th><th>熱量</th><th align="left">ひとこと</th><th align="left">よく動いた銘柄</th></tr>' +
    top.map(function (r) {
      return '<tr><td style="background:' + (STAGE_COLORS[r.stage] || '#fff') + '"><b>' + esc_(r.stage || '—') + '</b></td><td>' + esc_(r.theme) +
        '</td><td align="right">' + nz_(r.score) + '</td><td>' + esc_(r.reason) + '</td><td>' + esc_(r.leaders.join('、')) + '</td></tr>';
    }).join('') + '</table>' +
    '<p><a href="' + url + '">スプレッドシートを開く</a></p>' +
    '<p style="color:#888;font-size:12px">合図は「調べ始めるきっかけ」です。買う・売るの判断は、材料（ニュース・決算）と地合いを確かめてから。<br>' +
    'Yahoo Finance の非公式なデータを使っているため、まれに値が欠けたり遅れたりします。</p>';
  MailApp.sendEmail({ to: mailTo_(cfg), subject: subject, htmlBody: html, name: 'テーマレーダー' });
  if (force) return;
  props.setProperty('lastMailDate', res.date);
  var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  var log = sheet_(SHEETS.log.name);
  alerts.forEach(function (a) { log.appendRow([now, res.date, a.theme, a.stage, a.reason]); });
}

function notifyFailure_(cfg, failed, today) {
  var props = PropertiesService.getDocumentProperties();
  if (props.getProperty('lastFailMail') === today) return;
  props.setProperty('lastFailMail', today);
  var list = Object.keys(failed).slice(0, 20).map(function (s) { return s + '（' + failed[s] + '）'; }).join('、');
  MailApp.sendEmail({
    to: mailTo_(cfg), name: 'テーマレーダー',
    subject: '株価を取得できませんでした｜テーマレーダー',
    htmlBody: '<p>Yahoo Finance から株価をほとんど取得できなかったため、きょうの判定はお休みしました。</p><p>' + esc_(list) + '</p>' +
      '<p>一時的なことが多いので、明日も続くようならスプレッドシートのメニュー「今すぐ更新」で確かめてください。</p>'
  });
}

// 通知ログから、直近 days 日に送った「テーマ|状態」（同じ合図を何度も送らない）
function recentAlerts_(days) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.log.name), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  var since = Utilities.formatDate(new Date(Date.now() - days * 86400000), TZ, 'yyyy-MM-dd');
  sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
    if (dateStr_(r[0]).slice(0, 10) >= since) out[str_(r[2]) + '|' + str_(r[3])] = true;
  });
  return out;
}

function mailTo_(cfg) {
  return str_(cfg.mailTo) || Session.getEffectiveUser().getEmail();
}

// ---------- 小道具 ----------
function sheet_(name) {
  var ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function sparkline_(xs) {
  if (!xs || !xs.length) return '';
  return '=SPARKLINE(SPLIT("' + xs.join(' ') + '"," "),{"ymin",0;"ymax",100})';
}

function newsText_(nw) {
  if (!nw) return '';
  if (nw.count >= 100) return '100件以上（語が広すぎる）';
  return nw.count + '件' + (nw.ratio != null ? '（普段の' + nw.ratio.toFixed(1) + '倍）' : '（記録中）');
}

function nz_(x) {
  return x == null || (typeof x === 'number' && !isFinite(x)) ? '' : x;
}

function str_(v) {
  return v == null ? '' : String(v).trim();
}

function dateStr_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm') : str_(v);
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
