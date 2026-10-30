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
