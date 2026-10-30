// このファイルは theme-radar/tools/build.js で gas/ から自動生成しています。直接編集しないでください
// ===== Code.gs =====
// テーマ株レーダー：GAS（Googleスプレッドシート）側の処理
//   setup()        最初に1回。シートと毎日の自動実行（16時台・17時台）を作る
//   runDaily()     株価を取り、テーマごとの段階を判定してシートに書く（自動実行される）
//   runBacktest()  過去2年でシグナルの成績を確かめる（手動。1〜2分かかる）

var SHEET = {
  notice: '通知用', signal: 'シグナル', cand: '候補銘柄', alert: 'アラート', hist: '履歴',
  themes: 'テーマ', settings: '設定', bt: 'バックテスト', btList: 'バックテスト明細'
};

// [設定名, 初期値, 説明, エンジンの設定キー]
var SETTINGS = [
  ['ベンチマーク', '1306', '市場全体と比べるための銘柄（1306＝TOPIX連動ETF）', ''],
  ['候補の最低売買代金（円）', 50000000, '20日平均の売買代金がこれ未満の銘柄は2番手候補にしない', 'minTurnover'],
  ['初動の熱量', 55, '大きいほど通知が減り、確度が上がる（0〜100）', 'initHeat'],
  ['初動の急騰銘柄数', 3, '直近5日で急騰した銘柄がこの数以上で初動', 'initHot'],
  ['過熱の超過上昇率', 0.35, '20日間で市場より35%以上上がったら過熱', 'overEx20'],
  ['予兆も通知する', 'はい', '「はい」なら予兆（2銘柄の急騰）も通知の対象にする', ''],
  ['GASからもメールする', 'いいえ', '「はい」ならClaudeとは別に、数字だけのメールをGASからも送る', ''],
  ['通知先メール', '', '空欄なら自分のアドレス', '']
];

var ALERT_TYPES = { '初動': 1, '加速': 1, '過熱': 1, '失速': 1, '予兆': 1 };

function now_() { return new Date(); }

function onOpen() {
  SpreadsheetApp.getUi().createMenu('テーマ株レーダー')
    .addItem('今すぐ更新', 'runDaily')
    .addItem('バックテスト（過去2年）', 'runBacktest')
    .addItem('初期設定・自動実行の作り直し', 'setup')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActive();
  [SHEET.notice, SHEET.signal, SHEET.cand, SHEET.alert, SHEET.hist, SHEET.themes, SHEET.settings, SHEET.bt, SHEET.btList]
    .forEach(function (n, k) {
      var sh = ss.getSheetByName(n) || ss.insertSheet(n);
      ss.setActiveSheet(sh); ss.moveActiveSheet(k + 1);
    });
  var st = ss.getSheetByName(SHEET.settings);
  if (st.getLastRow() < 2) {
    st.getRange(1, 1, 1, 3).setValues([['設定', '値', '説明']]).setFontWeight('bold');
    st.getRange(2, 1, SETTINGS.length, 3).setValues(SETTINGS.map(function (s) { return [s[0], s[1], s[2]]; }));
    st.setColumnWidth(1, 200); st.setColumnWidth(3, 480);
  }
  var th = ss.getSheetByName(SHEET.themes);
  if (th.getLastRow() < 2) {
    var rows = [];
    Object.keys(DEFAULT_THEMES).forEach(function (t) {
      DEFAULT_THEMES[t].split('、').forEach(function (e) {
        var p = e.indexOf(':');
        rows.push([t, p < 0 ? e : e.slice(0, p), p < 0 ? '' : e.slice(p + 1), '', '', '']);
      });
    });
    th.getRange(1, 1, 1, 6).setValues([['テーマ', 'コード', '銘柄名', '取得名（自動）', '状態（自動）', 'メモ']]).setFontWeight('bold');
    th.getRange(2, 2, rows.length, 1).setNumberFormat('@');
    th.getRange(2, 1, rows.length, 6).setValues(rows);
    th.setFrozenRows(1);
  }
  var al = ss.getSheetByName(SHEET.alert);
  if (al.getLastRow() < 1) al.getRange(1, 1, 1, 7).setValues([['取引日', 'テーマ', 'シグナル', '熱量', '理由', '先導株', '2番手候補']]).setFontWeight('bold');
  var hi = ss.getSheetByName(SHEET.hist);
  if (hi.getLastRow() < 1) hi.getRange(1, 1, 1, 6).setValues([['取引日', 'テーマ', '段階', '熱量', '市場との差（5日）', '急騰銘柄数（5日）']]).setFontWeight('bold');

  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'runDaily') ScriptApp.deleteTrigger(t); });
  // 16時台に1回。株価の配信が遅れた日のために17時台にもう1回（同じ日の記録は二重に書かない）
  [16, 17].forEach(function (h) {
    ScriptApp.newTrigger('runDaily').timeBased().everyDays(1).atHour(h).nearMinute(15).inTimezone('Asia/Tokyo').create();
  });
  var blank = ss.getSheetByName('シート1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  ss.setActiveSheet(ss.getSheetByName(SHEET.notice));
  try { SpreadsheetApp.getUi().alert('初期設定が終わりました。毎日16時台と17時台に自動で更新します。\nメニュー「テーマ株レーダー → 今すぐ更新」で一度動かしてください。'); } catch (e) { /* エディタから実行したとき */ }
}

function readSettings_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET.settings);
  var v = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
  var map = {};
  v.forEach(function (r) { map[String(r[0]).trim()] = r[1]; });
  var eng = {};
  SETTINGS.forEach(function (s) { if (s[3] && map[s[0]] !== undefined && map[s[0]] !== '') eng[s[3]] = Number(map[s[0]]); });
  return {
    bench: String(map['ベンチマーク'] || '1306').trim(),
    engine: eng,
    notifyPre: String(map['予兆も通知する'] || 'はい').trim() !== 'いいえ',
    gasMail: String(map['GASからもメールする'] || 'いいえ').trim() === 'はい',
    mailTo: String(map['通知先メール'] || '').trim() || Session.getEffectiveUser().getEmail()
  };
}

function readUniverse_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET.themes);
  if (sh.getLastRow() < 2) throw new Error('「テーマ」シートが空です。setup を実行してください');
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getDisplayValues();
  var u = [], names = {};
  v.forEach(function (r) {
    var t = String(r[0]).trim(), c = String(r[1]).trim().toUpperCase();
    if (!t || !c) return;
    u.push({ theme: t, code: c });
    if (r[2] && !names[c]) names[c] = String(r[2]).trim();
  });
  return { universe: u, names: names };
}

// Yahoo!ファイナンス（米国版）の日足。codes: ['4493', '153A', ...] → {code: {name, bars}}
function fetchBars_(codes, range) {
  var out = {}, todo = codes.slice(), hosts = ['query1', 'query2'];
  var nowJst = Utilities.formatDate(now_(), 'Asia/Tokyo', 'yyyy-MM-dd HHmm');
  var today = nowJst.slice(0, 10), beforeClose = Number(nowJst.slice(11)) < 1530;
  for (var round = 0; round < 3 && todo.length; round++) {
    var failed = [];
    for (var s = 0; s < todo.length; s += 20) {
      var chunk = todo.slice(s, s + 20);
      var reqs = chunk.map(function (c) {
        return { url: 'https://' + hosts[round % 2] + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(c + '.T') +
          '?range=' + range + '&interval=1d', muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } };
      });
      var res = UrlFetchApp.fetchAll(reqs);
      res.forEach(function (r, k) {
        var code = chunk[k];
        if (r.getResponseCode() !== 200) { failed.push(code); return; }
        try {
          var j = JSON.parse(r.getContentText()).chart.result[0];
          var q = j.indicators.quote[0], ac = j.indicators.adjclose ? j.indicators.adjclose[0].adjclose : null;
          var bars = [];
          (j.timestamp || []).forEach(function (ts, i) {
            if (q.close[i] === null || q.open[i] === null || q.volume[i] === null) return;
            bars.push({ d: Utilities.formatDate(new Date(ts * 1000), 'Asia/Tokyo', 'yyyy-MM-dd'),
              o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i], ac: ac && ac[i] !== null ? ac[i] : q.close[i] });
          });
          // 取引時間中に動かしたときは、確定していない今日の足を使わない
          if (beforeClose && bars.length && bars[bars.length - 1].d === today) bars.pop();
          if (bars.length < 30) { failed.push(code); return; }
          out[code] = { name: j.meta.longName || j.meta.shortName || '', bars: bars };
        } catch (e) { failed.push(code); }
      });
      Utilities.sleep(300);
    }
    todo = failed;
    if (todo.length) Utilities.sleep(2000);
  }
  return { data: out, failed: todo };
}

function runDaily() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var ss = SpreadsheetApp.getActive(), cfg = readSettings_(), U = readUniverse_();
    var codes = {};
    U.universe.forEach(function (u) { codes[u.code] = 1; });
    codes[cfg.bench] = 1;
    var got = fetchBars_(Object.keys(codes), '1y');
    if (!got.data[cfg.bench]) throw new Error('ベンチマーク（' + cfg.bench + '）の株価が取得できませんでした。時間をおいて「今すぐ更新」を押してください');
    var an = Radar.analyze(U.universe, got.data, got.data[cfg.bench], cfg.engine);
    var lt = Radar.latest(an);
    var nm = function (c) { return U.names[c] || (got.data[c] && got.data[c].name) || c; };
    var stamp = Utilities.formatDate(now_(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
    var today = Utilities.formatDate(now_(), 'Asia/Tokyo', 'yyyy-MM-dd');
    var fresh = lt.date === today;

    writeThemeStatus_(ss, got);
    writeSignal_(ss, lt, stamp);
    writeCandidates_(ss, lt, nm);

    var alerts = [];
    lt.rows.forEach(function (r) {
      if (!r.event || !ALERT_TYPES[r.event]) return;
      if (r.event === '予兆' && !cfg.notifyPre) return;
      if (r.event === '失速' && !r.recentAlert) return;   // 知らせていないテーマの失速は通知しない
      alerts.push(r);
    });
    var alertRows = alerts.map(function (r) {
      return [lt.date, r.theme, r.event, r.day ? r.day.heat : '', Radar.reason(r.day),
        r.cand.leaders.map(function (x) { return nm(x.code) + '（' + x.code + '）'; }).join('、'),
        r.cand.next.map(function (x) { return nm(x.code) + '（' + x.code + '）'; }).join('、')];
    });
    if (fresh) {
      appendOnce_(ss.getSheetByName(SHEET.hist), lt.date, lt.rows.filter(function (r) { return r.day; }).map(function (r) {
        return [lt.date, r.theme, r.stage, r.day.heat, r.day.ex5, r.day.hot5];
      }));
      appendOnce_(ss.getSheetByName(SHEET.alert), lt.date, alertRows);
    }
    writeNotice_(ss, lt, alertRows, fresh, stamp, got.failed, U);
    if (fresh && alertRows.length && cfg.gasMail) {
      MailApp.sendEmail(cfg.mailTo, '[テーマ株レーダー] ' + lt.date + ' ' + alertRows.map(function (a) { return a[2] + ':' + a[1]; }).join(' / '),
        alertRows.map(function (a) { return '■' + a[2] + '：' + a[1] + '\n' + a[4] + '\n先導株：' + (a[5] || 'なし') + '\n2番手候補：' + (a[6] || 'なし'); }).join('\n\n') +
        '\n\n' + ss.getUrl() + '\n※数字だけの自動判定です。投資判断はご自身で行ってください。');
    }
  } catch (e) {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET.notice);
    if (sh) sh.getRange(1, 1, 2, 2).setValues([['状態', 'エラー'], ['内容', String(e && e.message || e)]]);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function writeThemeStatus_(ss, got) {
  var sh = ss.getSheetByName(SHEET.themes);
  if (sh.getLastRow() < 2) return;
  var n = sh.getLastRow() - 1, codes = sh.getRange(2, 2, n, 1).getDisplayValues();
  var out = codes.map(function (r) {
    var c = String(r[0]).trim().toUpperCase();
    if (!c) return ['', ''];
    var d = got.data[c];
    return d ? [d.name, 'OK'] : ['', '取得できません（コードの誤り・上場廃止・新規上場直後の可能性）'];
  });
  sh.getRange(2, 4, n, 2).setValues(out);
}

function writeSignal_(ss, lt, stamp) {
  var sh = ss.getSheetByName(SHEET.signal);
  var head = ['テーマ', '段階', '今日のシグナル', '熱量', '平常時の熱量', '値上がりの広がり', '出来高急増の割合', '高値更新の割合',
    '急騰銘柄数（5日）', 'ストップ高（5日）', '市場との差（1日）', '市場との差（5日）', '市場との差（20日）', '計算できた銘柄数', '取得できないコード'];
  var rows = lt.rows.map(function (r) {
    var d = r.day;
    if (!d) return [r.theme, '計算不可（銘柄が3つ未満）', '', '', '', '', '', '', '', '', '', '', '', 0, r.missing.join(' ')];
    return [r.theme, r.stage, r.event || '', d.heat, d.base === null ? '' : d.base, d.breadth, d.volBreadth, d.highBreadth,
      d.hot5, d.lu5, d.ex1, d.ex5, d.ex20, d.n, r.missing.join(' ')];
  });
  sh.clear();
  sh.getRange(1, 1).setValue('取引日 ' + lt.date + '（更新 ' + stamp + '）');
  sh.getRange(2, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  if (rows.length) {
    sh.getRange(3, 1, rows.length, head.length).setValues(rows);
    sh.getRange(3, 6, rows.length, 3).setNumberFormat('0%');
    sh.getRange(3, 11, rows.length, 3).setNumberFormat('+0.0%;-0.0%');
  }
  sh.setFrozenRows(2);
}

function writeCandidates_(ss, lt, nm) {
  var sh = ss.getSheetByName(SHEET.cand);
  var head = ['テーマ', '段階', '区分', 'コード', '銘柄名', '終値', '前日比', '5日', '出来高倍率', '出来高倍率（3日平均）', '売買代金（20日平均・百万円）', 'スコア'];
  var rows = [];
  lt.rows.forEach(function (r) {
    if (['初動', '加速', '過熱', '上昇中', '予兆'].indexOf(r.stage) < 0) return;
    r.cand.leaders.concat(r.cand.next).forEach(function (x) {
      rows.push([r.theme, r.stage, x.role, x.code, nm(x.code), x.close, x.ret1, x.ret5, Math.round(x.vr * 10) / 10,
        Math.round(x.vr3 * 10) / 10, Math.round(x.tv20 / 1e6), x.score]);
    });
  });
  sh.clear();
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  if (rows.length) {
    sh.getRange(2, 4, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, head.length).setValues(rows);
    sh.getRange(2, 7, rows.length, 2).setNumberFormat('+0.0%;-0.0%');
  }
  sh.setFrozenRows(1);
}

// 同じ取引日の行がまだなければ追加する
function appendOnce_(sh, date, rows) {
  if (!rows.length) return;
  var last = sh.getLastRow();
  if (last > 1) {
    var ds = sh.getRange(Math.max(2, last - 300), 1, Math.min(300, last - 1), 1).getDisplayValues();
    for (var k = 0; k < ds.length; k++) if (ds[k][0] === date) return;
  }
  sh.getRange(last + 1, 1, rows.length, 1).setNumberFormat('@');
  sh.getRange(last + 1, 1, rows.length, rows[0].length).setValues(rows);
}

// Claude の定期実行が最初に読むシート。1枚目に置き、今日の結論だけを書く
function writeNotice_(ss, lt, alertRows, fresh, stamp, failed, U) {
  var sh = ss.getSheetByName(SHEET.notice);
  var themes = {};
  U.universe.forEach(function (u) { themes[u.theme] = 1; });
  var rows = [
    ['状態', fresh ? (alertRows.length ? '新しいアラートあり' : 'アラートなし') : '今日の取引データなし（休場日・取得前）'],
    ['最終更新', stamp],
    ['対象の取引日', lt.date],
    ['アラート件数', fresh ? alertRows.length : 0],
    ['監視中のテーマ', Object.keys(themes).join('、')],
    ['取得できないコード', failed.join(' ')],
    ['', ''],
    ['段階の意味', '予兆＝2銘柄が急騰／初動＝急騰が3銘柄以上に広がった（買い検討）／加速＝テーマ全体に広がった／過熱＝新規の買いは控える／失速＝手仕舞い検討']
  ];
  sh.clear();
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange(1, 1, rows.length, 1).setFontWeight('bold');
  var head = ['取引日', 'テーマ', 'シグナル', '熱量', '理由', '先導株', '2番手候補'];
  sh.getRange(rows.length + 2, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  if (fresh && alertRows.length) {
    sh.getRange(rows.length + 3, 1, alertRows.length, 1).setNumberFormat('@');
    sh.getRange(rows.length + 3, 1, alertRows.length, head.length).setValues(alertRows);
  }
  sh.setColumnWidth(1, 120); sh.setColumnWidth(5, 520);
}

function runBacktest() {
  var ss = SpreadsheetApp.getActive(), cfg = readSettings_(), U = readUniverse_();
  var codes = {};
  U.universe.forEach(function (u) { codes[u.code] = 1; });
  codes[cfg.bench] = 1;
  var got = fetchBars_(Object.keys(codes), '2y');
  if (!got.data[cfg.bench]) throw new Error('ベンチマークの株価が取得できませんでした');
  var an = Radar.analyze(U.universe, got.data, got.data[cfg.bench], cfg.engine);
  var bt = Radar.backtest(an, [5, 10, 20]);
  var nm = function (c) { return U.names[c] || (got.data[c] && got.data[c].name) || c; };

  var sh = ss.getSheetByName(SHEET.bt);
  sh.clear();
  var head = ['シグナル', '回数', '対象', '5日後（平均）', '5日後（勝率）', '10日後（平均）', '10日後（勝率）', '20日後（平均）', '20日後（勝率）'];
  var rows = [];
  var label = { theme_: 'テーマ全体', next: '2番手候補（上位3）', leaders: '先導株' };
  ['予兆', '初動', '加速', '過熱', '失速'].forEach(function (ty) {
    var s = bt.summary[ty];
    ['theme_', 'next', 'leaders'].forEach(function (k) {
      var r = [ty, s.count, label[k]];
      [5, 10, 20].forEach(function (h) { var x = s[k + h]; r.push(x.avg === null ? '' : x.avg, x.win === null ? '' : x.win); });
      rows.push(r);
    });
  });
  var b = ['比較：毎日テーマを買った場合', bt.baseline[5].n, 'テーマ全体'];
  [5, 10, 20].forEach(function (h) { b.push(bt.baseline[h].avg === null ? '' : bt.baseline[h].avg, bt.baseline[h].win === null ? '' : bt.baseline[h].win); });
  rows.push(b);
  sh.getRange(1, 1).setValue('過去2年のシグナルの成績（翌営業日の始値で買い、n日後の終値で評価。市場＝' + cfg.bench + ' との差。手数料・売買できなかった日は考えていません）');
  sh.getRange(2, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sh.getRange(3, 1, rows.length, head.length).setValues(rows);
  sh.getRange(3, 4, rows.length, 6).setNumberFormat('+0.0%;-0.0%');
  [5, 7, 9].forEach(function (c) { sh.getRange(3, c, rows.length, 1).setNumberFormat('0%'); });

  var sl = ss.getSheetByName(SHEET.btList);
  sl.clear();
  var h2 = ['取引日', 'テーマ', 'シグナル', '熱量', 'テーマ 5日', 'テーマ 10日', 'テーマ 20日', '2番手 10日', '先導株 10日', '2番手候補', '先導株'];
  var r2 = bt.list.sort(function (a, b) { return a.date < b.date ? 1 : -1; }).map(function (r) {
    var f = function (v) { return v === null || v === undefined ? '' : v; };
    return [r.date, r.theme, r.type, r.heat, f(r.theme_[5]), f(r.theme_[10]), f(r.theme_[20]), f(r.next[10]), f(r.leaders[10]),
      r.nextCodes.map(nm).join('、'), r.leaderCodes.map(nm).join('、')];
  });
  sl.getRange(1, 1, 1, h2.length).setValues([h2]).setFontWeight('bold');
  if (r2.length) {
    sl.getRange(2, 1, r2.length, 1).setNumberFormat('@');
    sl.getRange(2, 1, r2.length, h2.length).setValues(r2);
    sl.getRange(2, 5, r2.length, 5).setNumberFormat('+0.0%;-0.0%');
  }
  sl.setFrozenRows(1);
  ss.setActiveSheet(sh);
}

// ===== Engine.gs =====
// テーマ株レーダーの計算部分（GAS の機能を使わないので Node でもそのまま試せる）
//
// 考え方：テーマ株の相場は「2銘柄ほどの急騰（予兆）→ 急騰が3銘柄以上に広がる（初動）
// → テーマ全体が出来高を伴って一斉に上がる（加速）→ ストップ高が連発し、市場より大きく上がる（過熱）
// → 広がりが縮む（失速）」の順に進むことが多い。
// 1銘柄ずつではなく「テーマに属する銘柄がまとまって動き出したか」を毎日数字にして、段階の変わり目を知らせる。
var Radar = (function () {
  var DEFAULTS = {
    minTurnover: 5e7,     // 候補銘柄にする 20日平均売買代金の下限（円）。小さすぎると売買できない
    hotRet: 0.08,         // 「急騰」とみなす1日の上昇率
    hotVr: 2,             // 「急騰」とみなす出来高倍率（20日平均比）
    preHot: 2,            // 予兆：直近5日で急騰した銘柄数
    preRise: 12,          // 予兆：熱量（3日平均）が平常時よりどれだけ高いか
    initHeat: 55,         // 初動：熱量
    initBase: 35,         // 初動：平常時の熱量がこれ未満（すでに盛り上がっているテーマは除く）
    initHot: 3,           // 初動：直近5日で急騰した銘柄数
    overEx20: 0.35,       // 過熱：20日間で市場より何割多く上がったか
    overLuShare: 0.3,     // 過熱：直近5日のストップ高の回数がテーマの銘柄数の何割か
    fadeRatio: 0.5,       // 失速：熱量が直近10日の最高の何割を下回ったか
    nextVr: 1.5,          // 2番手候補：直近3日の出来高倍率の平均がこれ以上
    maxCandidates: 5,
    maxLeaders: 3
  };
  var ACTIVE = { '初動': 1, '上昇中': 1, '加速': 1, '過熱': 1 };

  // 東証の制限値幅（基準値段＝前日終値ごと）
  var LIMITS = [[100, 30], [200, 50], [500, 80], [700, 100], [1000, 150], [1500, 300], [2000, 400], [3000, 500],
    [5000, 700], [7000, 1000], [10000, 1500], [15000, 3000], [20000, 4000], [30000, 5000], [50000, 7000],
    [70000, 10000], [100000, 15000], [150000, 30000], [200000, 40000], [300000, 50000], [500000, 70000],
    [700000, 100000], [1000000, 150000]];
  function limitWidth(p) {
    for (var k = 0; k < LIMITS.length; k++) if (p < LIMITS[k][0]) return LIMITS[k][1];
    return 300000;
  }

  function opt(o) {
    var r = {};
    for (var k in DEFAULTS) r[k] = DEFAULTS[k];
    for (var k2 in (o || {})) if (o[k2] !== undefined && o[k2] !== null && o[k2] !== '') r[k2] = o[k2];
    return r;
  }
  function mean(a) { if (!a.length) return null; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  // 1銘柄の日足から、日ごとの指標を作る。bars: [{d:'2026-10-06', o,h,l,c,v, ac(調整後終値・なければ c)}]
  function prepStock(bars, dates, o) {
    var n = bars.length, A = [], O = [], C = [], V = [], F = [];
    for (var j = 0; j < n; j++) {
      var b = bars[j], f = (b.ac && b.c) ? b.ac / b.c : 1;
      A.push(b.c * f); O.push(b.o * f); C.push(b.c); V.push(b.v || 0); F.push(f);
    }
    var byDate = {};
    for (var j2 = 0; j2 < n; j2++) byDate[bars[j2].d] = j2;
    var hot = [], m = [];
    for (var j3 = 0; j3 < n; j3++) {
      if (j3 < 21) { m.push(null); hot.push(false); continue; }
      var ret1 = A[j3] / A[j3 - 1] - 1;
      var sameF = Math.abs(F[j3] / F[j3 - 1] - 1) < 0.02;
      var lu = sameF && (C[j3] - C[j3 - 1] >= limitWidth(C[j3 - 1]) - 1e-9);
      var vs = 0, mx = -Infinity, tv = 0;
      for (var k = j3 - 20; k < j3; k++) { vs += V[k]; if (A[k] > mx) mx = A[k]; }
      for (var k2 = j3 - 19; k2 <= j3; k2++) tv += C[k2] * V[k2];
      var vavg = vs / 20, vr = vavg > 0 ? V[j3] / vavg : 0;
      var s25 = 0, c25 = 0;
      for (var k3 = Math.max(0, j3 - 24); k3 <= j3; k3++) { s25 += A[k3]; c25++; }
      var m60 = -Infinity;
      for (var k4 = Math.max(0, j3 - 59); k4 <= j3; k4++) if (A[k4] > m60) m60 = A[k4];
      var h = lu || (ret1 >= o.hotRet && vr >= o.hotVr);
      hot.push(h);
      m.push({
        ret1: ret1, lu: lu, vr: vr, hi20: A[j3] > mx, ab25: A[j3] > s25 / c25,
        ret3: A[j3] / A[j3 - 3] - 1, ret5: A[j3] / A[j3 - 5] - 1,
        tv20: tv / 20, near60: A[j3] / m60, hot: h, close: C[j3]
      });
    }
    // 共通の日付（ベンチマークの営業日）にそろえる
    var al = [], aA = [], aO = [];
    for (var i = 0; i < dates.length; i++) {
      var jj = byDate[dates[i]];
      al.push(jj === undefined ? null : m[jj]);
      aA.push(jj === undefined ? null : A[jj]);
      aO.push(jj === undefined ? null : O[jj]);
    }
    return { m: al, A: aA, O: aO };
  }

  // universe: [{theme, code}], data: {code: {name, bars}}, bench: {bars}
  function analyze(universe, data, bench, options) {
    var o = opt(options);
    var dates = bench.bars.map(function (b) { return b.d; });
    var T = dates.length;
    var BA = bench.bars.map(function (b) { return b.ac ? b.ac : b.c; });
    var BO = bench.bars.map(function (b) { return (b.ac && b.c) ? b.o * b.ac / b.c : b.o; });
    var stocks = {};
    for (var code in data) if (data[code] && data[code].bars && data[code].bars.length) stocks[code] = prepStock(data[code].bars, dates, o);

    var themeNames = [], members = {};
    universe.forEach(function (u) {
      if (!members[u.theme]) { members[u.theme] = []; themeNames.push(u.theme); }
      if (members[u.theme].indexOf(u.code) < 0) members[u.theme].push(u.code);
    });

    var themes = {};
    themeNames.forEach(function (name) {
      var codes = members[name].filter(function (c) { return stocks[c]; });
      var days = [], L = [], stage = [], events = [];
      var lastPre = -999, lastAcc = -999, activeDays = 0;
      for (var i = 0; i < T; i++) {
        var rs = [], br = 0, vb = 0, hb = 0, n = 0;
        codes.forEach(function (c) {
          var x = stocks[c].m[i];
          if (!x) return;
          n++;
          rs.push(clamp(x.ret1, -0.3, 0.3));
          if (x.ret1 >= 0.03) br++;
          if (x.vr >= 2) vb++;
          if (x.hi20) hb++;
        });
        var prevL = i > 0 ? L[i - 1] : 1;
        if (n < 3) { days.push(null); L.push(prevL); stage.push(i > 0 ? stage[i - 1] : '平常'); continue; }
        var mr = mean(rs);
        L.push(prevL * (1 + mr));
        var bret1 = i > 0 ? BA[i] / BA[i - 1] - 1 : 0;
        var ex5 = i >= 5 ? (L[i] / L[i - 5]) - (BA[i] / BA[i - 5]) : 0;
        var ex20 = i >= 20 ? (L[i] / L[i - 20]) - (BA[i] / BA[i - 20]) : 0;
        var hotSet = {}, lu5 = 0;
        for (var k = Math.max(0, i - 4); k <= i; k++) {
          codes.forEach(function (c) {
            var y = stocks[c].m[k];
            if (y && y.hot) hotSet[c] = 1;
            if (y && y.lu) lu5++;
          });
        }
        var hot5 = Object.keys(hotSet).length;
        var luToday = 0;
        codes.forEach(function (c) { var z = stocks[c].m[i]; if (z && z.lu) luToday++; });
        var heat = 25 * Math.min((br / n) / 0.5, 1) + 25 * Math.min((vb / n) / 0.4, 1) + 15 * Math.min((hb / n) / 0.4, 1)
          + 20 * Math.min(hot5 / Math.max(3, n * 0.25), 1) + 15 * clamp(ex5 / 0.10, 0, 1);
        heat = Math.round(heat * 10) / 10;
        var d = { date: dates[i], n: n, heat: heat, breadth: br / n, volBreadth: vb / n, highBreadth: hb / n,
          ret1: mr, ex1: mr - bret1, ex5: ex5, ex20: ex20, hot5: hot5, hotCodes: Object.keys(hotSet), lu5: lu5, luToday: luToday };
        days.push(d);

        // 平常時の熱量：6〜25日前の平均（直近の盛り上がりを含めない）
        var bs = [];
        for (var k2 = Math.max(0, i - 25); k2 <= i - 6; k2++) if (days[k2]) bs.push(days[k2].heat);
        d.base = bs.length >= 10 ? Math.round(mean(bs) * 10) / 10 : null;
        var h3 = [];
        for (var k3 = Math.max(0, i - 2); k3 <= i; k3++) if (days[k3]) h3.push(days[k3].heat);
        d.heat3 = mean(h3);
        var peak = 0;
        for (var k4 = Math.max(0, i - 9); k4 <= i; k4++) if (days[k4] && days[k4].heat > peak) peak = days[k4].heat;

        var prev = i > 0 ? stage[i - 1] : '平常';
        var active = !!ACTIVE[prev], st;
        activeDays = active ? activeDays + 1 : 0;
        var hot5ago = (i >= 3 && days[i - 3]) ? days[i - 3].hot5 : 0;
        if (active) {
          if (heat >= 60 && (ex20 >= o.overEx20 || lu5 >= Math.max(3, Math.ceil(n * o.overLuShare)))) st = '過熱';
          // 盛り上がりの直後の一服で降ろさないよう、失速は初動から5日以上たってから判定する
          else if (activeDays >= 5 && (d.heat3 < peak * o.fadeRatio || d.heat3 < 20)) st = '失速';
          else if (heat >= 80 && hot5 - hot5ago >= 3) st = '加速';
          else st = '上昇中';
        }
        else if (heat >= o.initHeat && (d.base === null || d.base < o.initBase) && hot5 >= o.initHot && ex20 < o.overEx20) st = '初動';
        else if (hot5 >= o.preHot && d.base !== null && d.heat3 >= d.base + o.preRise && heat >= 25) st = '予兆';
        else st = '平常';
        stage.push(st);
        d.stage = st;
        d.peak10 = peak;
        d.activeDays = activeDays;

        var ev = null;
        if (st === '初動') ev = '初動';
        else if (st === '過熱' && prev !== '過熱') ev = '過熱';
        else if (st === '加速' && i - lastAcc >= 5) { ev = '加速'; lastAcc = i; }
        else if (st === '失速') ev = '失速';
        else if (st === '予兆' && prev !== '予兆' && i - lastPre >= 10) { ev = '予兆'; lastPre = i; }
        if (ev) events.push({ i: i, date: dates[i], type: ev });
      }
      themes[name] = { codes: codes, allCodes: members[name], days: days, stage: stage, events: events, L: L };
    });
    return { dates: dates, themes: themes, stocks: stocks, BA: BA, BO: BO, opt: o };
  }

  // テーマの中の銘柄を「先導株（もう動いた）」と「2番手候補（これから動く可能性）」に分ける
  function candidates(an, theme, i) {
    var o = an.opt, t = an.themes[theme], leaders = [], others = [];
    t.codes.forEach(function (c) {
      var x = an.stocks[c].m[i];
      if (!x) return;
      var vrs = [];
      for (var k = Math.max(0, i - 2); k <= i; k++) { var y = an.stocks[c].m[k]; if (y) vrs.push(y.vr); }
      var vr3 = mean(vrs) || 0;
      var luRecent = false, hotRecent = false;
      for (var k2 = Math.max(0, i - 4); k2 <= i; k2++) { var z = an.stocks[c].m[k2]; if (z && z.lu) luRecent = true; if (z && z.hot) hotRecent = true; }
      var row = { code: c, close: x.close, ret1: x.ret1, ret5: x.ret5, vr: x.vr, vr3: vr3, tv20: x.tv20, lu: x.lu };
      if (x.ret5 >= 0.15 || luRecent || (hotRecent && x.ret5 >= 0.08)) {
        row.role = '先導株';
        row.score = Math.round(x.ret5 * 1000) / 10;
        leaders.push(row);
        return;
      }
      // 2番手候補は「まだ大きく上がっていないが、出来高が増え始めた銘柄」。出来高が増えていなければ候補にしない
      if (x.tv20 < o.minTurnover || vr3 < o.nextVr || x.ret3 <= 0) return;
      var s = 35 * Math.min(vr3 / 3, 1) + 25 * clamp(x.ret3 / 0.06, 0, 1)
        + 20 * (x.near60 >= 0.92 ? 1 : x.near60 >= 0.85 ? 0.5 : 0) + 20 * (x.ab25 ? 1 : 0);
      row.role = '2番手候補';
      row.score = Math.round(s);
      if (s >= 50) others.push(row);
    });
    leaders.sort(function (a, b) { return b.ret5 - a.ret5; });
    others.sort(function (a, b) { return b.score - a.score; });
    return { leaders: leaders.slice(0, o.maxLeaders), next: others.slice(0, o.maxCandidates) };
  }

  // 翌営業日の始値で買い、h 日後の終値で評価（市場＝ベンチマークとの差）
  function fwd(an, codes, i, h) {
    var j = i + h, T = an.dates.length;
    if (i + 1 >= T || j >= T) return null;
    var rs = [];
    codes.forEach(function (c) {
      var s = an.stocks[c];
      if (!s || s.O[i + 1] === null || s.A[j] === null) return;
      rs.push(s.A[j] / s.O[i + 1] - 1);
    });
    if (!rs.length) return null;
    return mean(rs) - (an.BA[j] / an.BO[i + 1] - 1);
  }

  // 過去の各シグナルの後に、テーマ・候補銘柄が市場よりどれだけ上がったか
  function backtest(an, horizons) {
    horizons = horizons || [5, 10, 20];
    var list = [], summary = {}, base = {};
    Object.keys(an.themes).forEach(function (name) {
      var t = an.themes[name];
      t.events.forEach(function (e) {
        var cd = candidates(an, name, e.i);
        var r = { theme: name, date: e.date, type: e.type, heat: t.days[e.i].heat, theme_: {}, next: {}, leaders: {},
          nextCodes: cd.next.slice(0, 3).map(function (x) { return x.code; }), leaderCodes: cd.leaders.map(function (x) { return x.code; }) };
        horizons.forEach(function (h) {
          r.theme_[h] = fwd(an, t.codes, e.i, h);
          r.next[h] = r.nextCodes.length ? fwd(an, r.nextCodes, e.i, h) : null;
          r.leaders[h] = r.leaderCodes.length ? fwd(an, r.leaderCodes, e.i, h) : null;
        });
        list.push(r);
      });
      // 比較用：シグナルに関係なく、毎日そのテーマを買った場合
      for (var i = 0; i < an.dates.length; i++) {
        if (!t.days[i]) continue;
        horizons.forEach(function (h) {
          var v = fwd(an, t.codes, i, h);
          if (v === null) return;
          base[h] = base[h] || []; base[h].push(v);
        });
      }
    });
    var types = ['予兆', '初動', '加速', '過熱', '失速'];
    types.forEach(function (ty) {
      var es = list.filter(function (r) { return r.type === ty; });
      var s = { count: es.length };
      horizons.forEach(function (h) {
        ['theme_', 'next', 'leaders'].forEach(function (k) {
          var v = es.map(function (r) { return r[k][h]; }).filter(function (x) { return x !== null && x !== undefined; });
          s[k + h] = { n: v.length, avg: mean(v), win: v.length ? v.filter(function (x) { return x > 0; }).length / v.length : null };
        });
      });
      summary[ty] = s;
    });
    var baseline = {};
    horizons.forEach(function (h) { var v = base[h] || []; baseline[h] = { n: v.length, avg: mean(v), win: v.length ? v.filter(function (x) { return x > 0; }).length / v.length : null }; });
    return { list: list, summary: summary, baseline: baseline, horizons: horizons };
  }

  // 一番新しい日の、テーマごとの状況
  function latest(an) {
    var i = an.dates.length - 1, rows = [];
    Object.keys(an.themes).forEach(function (name) {
      var t = an.themes[name], d = t.days[i];
      var prevStage = i > 0 ? t.stage[i - 1] : '平常';
      var ev = null;
      t.events.forEach(function (e) { if (e.i === i) ev = e.type; });
      var lastAlert = null;
      t.events.forEach(function (e) { if ((e.type === '初動' || e.type === '予兆') && e.i <= i) lastAlert = e; });
      rows.push({ theme: name, day: d, stage: t.stage[i], prevStage: prevStage, event: ev,
        recentAlert: lastAlert && i - lastAlert.i <= 30 ? lastAlert : null,
        cand: d ? candidates(an, name, i) : { leaders: [], next: [] },
        missing: t.allCodes.filter(function (c) { return t.codes.indexOf(c) < 0; }) });
    });
    var order = { '初動': 0, '加速': 1, '過熱': 2, '予兆': 3, '失速': 4, '上昇中': 5, '平常': 6 };
    rows.sort(function (a, b) {
      return (order[a.stage] - order[b.stage]) || ((b.day ? b.day.heat : 0) - (a.day ? a.day.heat : 0));
    });
    return { date: an.dates[i], rows: rows };
  }

  // 通知に載せる理由の文章
  function reason(d) {
    if (!d) return '';
    var p = function (x) { return (x >= 0 ? '+' : '') + Math.round(x * 1000) / 10 + '%'; };
    return '急騰' + d.hot5 + '銘柄（5日・ストップ高' + d.lu5 + '回）、値上がりの広がり' + Math.round(d.breadth * 100) +
      '%、出来高急増' + Math.round(d.volBreadth * 100) + '%、市場との差 5日' + p(d.ex5) + '・20日' + p(d.ex20) +
      '、熱量' + d.heat + '（平常時' + (d.base === null ? '-' : d.base) + '）';
  }

  return { DEFAULTS: DEFAULTS, limitWidth: limitWidth, analyze: analyze, candidates: candidates, backtest: backtest, latest: latest, reason: reason };
})();

// ===== Themes.gs =====
// 初期設定で「テーマ」シートに書き込む、テーマと銘柄コードの一覧（2026年10月時点で作成）
// 「コード:銘柄名」を「、」で区切って並べる。株価の取得時に取れた正式名（英語）は「取得名」列に入る。コードの誤りや上場廃止は「状態」列に「取得できません」と出るので、
// そのときはシートで直す。テーマや銘柄の追加・削除もシートで自由にしてよい（1テーマ3銘柄以上）。
var DEFAULT_THEMES = {
  'サイバーセキュリティ': '4704:トレンドマイクロ、4493:サイバーセキュリティクラウド、3042:セキュアヴェイル、4398:ブロードバンドセキュリティ、9250:GRCS、153A:カウリス、338A:ZenmuTech、4288:アズジェント、3967:エルテス、3692:FFRIセキュリティ、2326:デジタルアーツ、3857:ラック、4417:グローバルセキュリティエキスパート、3040:ソリトンシステムズ、4258:網屋、3916:デジタル・インフォメーション・テクノロジー',
  '防衛': '7011:三菱重工業、7012:川崎重工業、7013:IHI、6203:豊和工業、7721:東京計器、6946:日本アビオニクス、6208:石川製作所、7980:重松製作所、4274:細谷火工、5631:日本製鋼所、6503:三菱電機',
  '半導体製造装置・材料': '8035:東京エレクトロン、6857:アドバンテスト、6146:ディスコ、6920:レーザーテック、7735:SCREENホールディングス、6323:ローツェ、3436:SUMCO、6890:フェローテックHD、6871:日本マイクロニクス、6315:TOWA、7729:東京精密、6254:野村マイクロ・サイエンス、6266:タツモ',
  'AIデータセンター・電線': '5803:フジクラ、5802:住友電気工業、5801:古河電気工業、5805:SWCC、6501:日立製作所、6504:富士電機、1942:関電工、1944:きんでん、3778:さくらインターネット、3774:IIJ',
  '生成AI・AIソフト': '3993:PKSHA Technology、4011:ヘッドウォータース、4488:AI inside、4382:HEROZ、4388:エーアイ、5574:ABEJA、2158:FRONTEO、4180:Appier Group、5586:Laboro.AI、9984:ソフトバンクグループ',
  'フィジカルAI・ロボット': '6954:ファナック、6506:安川電機、6324:ハーモニック・ドライブ・システムズ、6268:ナブテスコ、6383:ダイフク、6861:キーエンス、6481:THK、7779:CYBERDYNE、6232:ACSL',
  '量子コンピュータ': '6702:富士通、6701:NEC、3687:フィックスターズ、6597:HPCシステムズ、6613:QDレーザ、7713:シグマ光機、3915:テラスカイ、6864:エヌエフHD、6965:浜松ホトニクス',
  '宇宙': '186A:アストロスケールHD、290A:Synspective、464A:QPSホールディングス、9348:ispace、402A:アクセルスペースHD、3741:セック、7013:IHI',
  '光電融合・光通信': '9432:NTT、6834:精工技研、5821:平河ヒューテック、4062:イビデン、6787:メイコー、5803:フジクラ、6613:QDレーザ',
  '原子力・電力': '9501:東京電力HD、9503:関西電力、9506:東北電力、9508:九州電力、5631:日本製鋼所、6378:木村化工機、6330:東洋エンジニアリング、6366:千代田化工建設、1963:日揮HD',
  '資源・レアアース': '5713:住友金属鉱山、5711:三菱マテリアル、5706:三井金属、5707:東邦亜鉛、5715:古河機械金属、5726:大阪チタニウムテクノロジーズ、5727:東邦チタニウム、4022:ラサ工業、1514:住石HD、1605:INPEX、1662:石油資源開発',
  '造船・海運': '7003:三井E&S、7014:名村造船所、7018:内海造船、9101:日本郵船、9104:商船三井、9107:川崎汽船',
  'インバウンド・観光': '9603:エイチ・アイ・エス、3099:三越伊勢丹HD、8233:高島屋、9201:日本航空、9202:ANAHD、4661:オリエンタルランド、6040:日本スキー場開発、7532:パン・パシフィックHD、9722:藤田観光',
  '銀行・金利上昇': '8306:三菱UFJ FG、8316:三井住友FG、8411:みずほFG、8308:りそなHD、7186:横浜FG（旧コンコルディアFG）、8331:千葉銀行、8354:ふくおかFG、7167:めぶきFG',
  'バイオ・創薬': '4592:サンバイオ、4565:ネクセラファーマ、4587:ペプチドリーム、4588:オンコリスバイオファーマ、4599:ステムリム、4978:リプロセル、2370:メディネット、4582:シンバイオ製薬、4572:カルナバイオサイエンス、4593:ヘリオス',
  '医療DX': '2413:エムスリー、4483:JMDC、4480:メドレー、3902:メディカル・データ・ビジョン、6034:MRT、3649:ファインデックス',
  '感染症対策': '3604:川本産業、7980:重松製作所、7963:興研、4549:栄研化学、4556:カイノス、4524:森下仁丹',
  '再エネ・洋上風力': '1407:ウエストHD、9517:イーレックス、9519:レノバ、6255:エヌ・ピー・シー、6013:タクマ、9514:エフオン',
  '暗号資産・Web3': '3350:メタプラネット、8698:マネックスグループ、8473:SBIホールディングス、3807:フィスコ',
  '自動運転': '593A:ティアフォー、6902:デンソー、6723:ルネサスエレクトロニクス、4425:Kudan、7276:小糸製作所',
  'ゲーム・アニメ': '7974:任天堂、9684:スクウェア・エニックスHD、9697:カプコン、9766:コナミグループ、4816:東映アニメーション、9468:KADOKAWA、3659:ネクソン、7832:バンダイナムコHD',
  '農業・食料': '6310:井関農機、6326:クボタ、4979:OATアグリオ、4997:日本農薬、1384:ホクリヨウ、2931:ユーグレナ',
  'ペロブスカイト太陽電池': '4204:積水化学工業、4107:伊勢化学工業、4092:日本化学工業',
  '次世代電池': '4080:田中化学研究所、6619:ダブル・スコープ、6810:マクセル、4109:ステラケミファ、3891:ニッポン高度紙工業、6752:パナソニックHD'
};
