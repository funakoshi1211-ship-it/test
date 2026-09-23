/**
 * シフト作成ツール（サーバー側）
 * スプレッドシートの読み書きと、Webアプリの表示だけを担当する。
 * 自動作成とルール判定はブラウザ側（Logic.html）で行う。
 */

var TZ = 'Asia/Tokyo';

var SHEETS = {
  stores: { name: '店舗', header: ['記号', '店舗名'] },
  reqs: { name: '必要人数', header: ['店舗記号', '曜日区分（平日/土曜/当番）', '時間帯（午前/午後）', '薬剤師', '事務'] },
  staff: {
    name: '社員',
    header: ['ID', '氏名', '職種（管薬/薬/事務）', '区分（常勤/準常勤/非常勤/外部）', '所属店舗（記号）', '固定（○）',
      '応援できる店舗（記号を並べる）', '夜勤可（○）', '出勤できない曜日（例：水土）', '週の出勤上限（非常勤）',
      '週の店舗出勤上限', '週の在宅日数', '平日の終業時刻', '土曜の終業時刻', '表示順']
  },
  holidays: { name: '祝日・休業日', header: ['日付', '名称'] },
  extra: { name: '臨時営業', header: ['日付', '店舗記号', '時間帯（午前/午後/終日）', 'メモ'] },
  duty: { name: '夜間当番日', header: ['日付'] },
  periods: { name: '特別期間', header: ['名称', '開始日', '終了日'] },
  periodReqs: { name: '特別期間の必要人数', header: ['特別期間の名称', '店舗記号', '曜日区分（平日/土曜/当番）', '時間帯（午前/午後）', '薬剤師', '事務'] },
  requests: { name: '希望', header: ['年月', '社員ID', '日付', '午前', '午後', '夜'] },
  shift: { name: 'シフト', header: ['年月', '社員ID', '日付', '午前', '午後', '夜'] }
};

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('シフト作成')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('シフト')
    .addItem('初期設定（シートを作る）', 'setup')
    .addToUi();
}

// ---------- 初期設定 ----------
function setup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (k) {
    var def = SHEETS[k];
    var sh = ss.getSheetByName(def.name);
    if (!sh) sh = ss.insertSheet(def.name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, def.header.length).setValues([def.header]).setFontWeight('bold').setBackground('#eef2f5');
      sh.setFrozenRows(1);
    }
  });
  seed_(SHEETS.stores.name, [['一', '一番町'], ['三', '三番町'], ['中', '中一万'], ['山', '山越'], ['松', '松山']]);
  seed_(SHEETS.reqs.name, defaultRequirements_());
  seed_(SHEETS.holidays.name, defaultHolidays_());
  seed_(SHEETS.duty.name, defaultDutyDates_());
  seed_(SHEETS.periods.name, [
    ['お盆', '2026-08-12', '2026-08-15'],
    ['年末年始', '2026-12-28', '2027-01-04'],
    ['ゴールデンウィーク', '2027-04-29', '2027-05-05'],
    ['お盆', '2027-08-11', '2027-08-16']
  ]);
  ['希望', 'シフト', '祝日・休業日', '夜間当番日', '特別期間', '臨時営業'].forEach(function (n) {
    ss.getSheetByName(n).getRange('A:C').setNumberFormat('@');
  });
  var first = ss.getSheetByName('シート1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
  SpreadsheetApp.getActive().toast('シートを作成しました。「社員」シートに社員を登録してください。', 'シフト作成', 8);
}

function seed_(name, rows) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (sh.getLastRow() > 1 || !rows.length) return;
  sh.getRange(2, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
}

function defaultRequirements_() {
  // 店舗: [平日午前 薬,事, 平日午後 薬,事, 土曜午前 薬,事]
  var table = {
    '三': [3, 2, 2, 2, 2, 1],
    '一': [1, 1, 1, 1, 1, 1],
    '中': [2, 1, 2, 1, 2, 1],
    '山': [1, 1, 1, 1, 2, 1],
    '松': [2, 2, 2, 2, 2, 2]
  };
  var rows = [];
  Object.keys(table).forEach(function (st) {
    var t = table[st];
    rows.push([st, '平日', '午前', t[0], t[1]]);
    rows.push([st, '平日', '午後', t[2], t[3]]);
    rows.push([st, '土曜', '午前', t[4], t[5]]);
  });
  rows.push(['三', '当番', '午前', 1, 0]);
  rows.push(['三', '当番', '午後', 1, 0]);
  return rows;
}

function defaultHolidays_() {
  return [
    ['2026-08-11', '山の日'], ['2026-09-21', '敬老の日'], ['2026-09-22', '国民の休日'], ['2026-09-23', '秋分の日'],
    ['2026-10-12', 'スポーツの日'], ['2026-11-03', '文化の日'], ['2026-11-23', '勤労感謝の日'],
    ['2027-01-01', '元日'], ['2027-01-11', '成人の日'], ['2027-02-11', '建国記念の日'],
    ['2027-02-23', '天皇誕生日'], ['2027-03-22', '振替休日'], ['2027-04-29', '昭和の日'],
    ['2027-05-03', '憲法記念日'], ['2027-05-04', 'みどりの日'], ['2027-05-05', 'こどもの日'],
    ['2027-07-19', '海の日'], ['2027-08-11', '山の日'], ['2027-09-20', '敬老の日'],
    ['2027-09-23', '秋分の日'], ['2027-10-11', 'スポーツの日'], ['2027-11-03', '文化の日'],
    ['2027-11-23', '勤労感謝の日']
  ];
}

function defaultDutyDates_() {
  var rows = [], d = new Date(2026, 7, 1), end = new Date(2027, 11, 31);
  while (d <= end) {
    rows.push([Utilities.formatDate(d, TZ, 'yyyy-MM-dd')]);
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 8);
  }
  return rows;
}

// ---------- 読み込み ----------
function rows_(key) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS[key].name);
  if (!sh) throw new Error('「' + SHEETS[key].name + '」シートがありません。メニューの「シフト」→「初期設定」を実行してください。');
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, SHEETS[key].header.length).getValues()
    .filter(function (r) { return r.some(function (v) { return v !== ''; }); });
}

function str_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v).trim();
}
function date_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  var s = str_(v).replace(/\//g, '-');
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : s;
}
function ym_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM');
  return str_(v).replace(/\//g, '-');
}
function slot_(v) { v = str_(v); return v === '午前' ? 'AM' : v === '午後' ? 'PM' : v === '終日' || v === '' ? 'ALL' : v; }
function yes_(v) { v = str_(v); return v === '○' || v === '〇' || v === 'o' || v === 'O' || v === 'TRUE' || v === 'true' || v === '1'; }
function chars_(v) { return str_(v).replace(/[\s,、・]/g, '').split('').filter(Boolean); }
function num_(v) { var n = Number(v); return v === '' || isNaN(n) ? null : n; }

var WEEKDAYS = '日月火水木金土';

function getData(ym) {
  var master = {
    stores: rows_('stores').map(function (r) { return { code: str_(r[0]), name: str_(r[1]) }; }),
    requirements: rows_('reqs').map(function (r) {
      return { store: str_(r[0]), dayType: str_(r[1]), slot: slot_(r[2]), pharm: num_(r[3]) || 0, clerk: num_(r[4]) || 0 };
    }),
    staff: rows_('staff').map(function (r, i) {
      return {
        id: str_(r[0]) || str_(r[1]), name: str_(r[1]), job: str_(r[2]), kind: str_(r[3]), home: str_(r[4]), fixed: yes_(r[5]),
        canStores: chars_(r[6]), night: yes_(r[7]),
        ngWeekdays: chars_(r[8]).map(function (c) { return WEEKDAYS.indexOf(c); }).filter(function (n) { return n >= 0; }),
        weeklyMax: num_(r[9]), weeklyStoreMax: num_(r[10]), weeklyRemote: num_(r[11]) || 0,
        endWeekday: str_(r[12]), endSat: str_(r[13]), order: num_(r[14]) || (i + 1)
      };
    }).filter(function (s) { return s.id && s.name; }),
    holidays: rows_('holidays').map(function (r) { return { date: date_(r[0]), name: str_(r[1]) }; }),
    extraOpen: rows_('extra').map(function (r) { return { date: date_(r[0]), store: str_(r[1]), slot: slot_(r[2]) }; }),
    dutyDates: rows_('duty').map(function (r) { return date_(r[0]); }),
    specialPeriods: rows_('periods').map(function (r) { return { name: str_(r[0]), start: date_(r[1]), end: date_(r[2]) }; }),
    specialReqs: rows_('periodReqs').map(function (r) {
      return { period: str_(r[0]), store: str_(r[1]), dayType: str_(r[2]), slot: slot_(r[3]), pharm: num_(r[4]) || 0, clerk: num_(r[5]) || 0 };
    })
  };
  return { ym: ym, master: master, requests: readCells_('requests', ym), cells: readCells_('shift', ym) };
}

function readCells_(key, ym) {
  var out = {}, found = false;
  rows_(key).forEach(function (r) {
    if (ym_(r[0]) !== ym) return;
    var id = str_(r[1]), d = date_(r[2]);
    out[id] = out[id] || {};
    out[id][d] = { AM: str_(r[3]), PM: str_(r[4]), N: str_(r[5]) };
    found = true;
  });
  return found ? out : null;
}

// ---------- 保存 ----------
function saveRequests(ym, map) { writeCells_('requests', ym, map); return true; }
function saveShift(ym, map) { writeCells_('shift', ym, map); return true; }

function writeCells_(key, ym, map) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS[key].name);
    var width = SHEETS[key].header.length;
    var keep = rows_(key).filter(function (r) { return ym_(r[0]) !== ym; })
      .map(function (r) { return [ym_(r[0]), str_(r[1]), date_(r[2]), str_(r[3]), str_(r[4]), str_(r[5])]; });
    var add = [];
    Object.keys(map || {}).forEach(function (id) {
      Object.keys(map[id]).sort().forEach(function (d) {
        var c = map[id][d];
        if (c.AM || c.PM || c.N) add.push([ym, id, d, c.AM || '', c.PM || '', c.N || '']);
      });
    });
    var all = keep.concat(add);
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, width).clearContent();
    if (all.length) sh.getRange(2, 1, all.length, width).setNumberFormat('@').setValues(all);
  } finally {
    lock.releaseLock();
  }
}

// ---------- 印刷用シート ----------
function exportPrint(ym, cells) {
  var data = getData(ym);
  var ss = SpreadsheetApp.getActive();
  var name = '印刷_' + ym;
  var sh = ss.getSheetByName(name);
  if (sh) sh.clear(); else sh = ss.insertSheet(name);

  var p = ym.split('-'), y = +p[0], m = +p[1];
  var n = new Date(y, m, 0).getDate();
  var hol = {}; data.master.holidays.forEach(function (h) { hol[h.date] = true; });
  var duty = {}; data.master.dutyDates.forEach(function (d) { duty[d] = true; });
  var dates = [];
  for (var d = 1; d <= n; d++) dates.push(Utilities.formatDate(new Date(y, m - 1, d), TZ, 'yyyy-MM-dd'));

  var head1 = ['シフト表 ' + y + '年' + m + '月', '', ''].concat(dates.map(function (x, i) { return i + 1; }));
  var head2 = ['氏名', '職種', '区分'].concat(dates.map(function (x) { return WEEKDAYS[new Date(x + 'T00:00:00').getDay()]; }));
  var values = [head1, head2];
  var staff = data.master.staff.slice().sort(function (a, b) { return a.order - b.order; });
  staff.forEach(function (s) {
    var am = [s.name, s.job, s.kind], pm = ['', '', ''];
    dates.forEach(function (x) {
      var c = (cells[s.id] && cells[s.id][x]) || {};
      am.push((c.AM || '') + (c.N === '深夜' ? (c.AM ? ' ' : '') + '0-9' : ''));
      pm.push((c.PM || '') + (c.N === '準夜' ? (c.PM ? ' ' : '') + '16-24' : ''));
    });
    values.push(am, pm);
  });
  sh.getRange(1, 1, values.length, values[0].length).setValues(values)
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setFontSize(9);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold').setHorizontalAlignment('left');
  sh.getRange(2, 1, 1, values[0].length).setFontWeight('bold').setBackground('#eef2f5');
  for (var i = 0; i < staff.length; i++) {
    var r = 3 + i * 2;
    sh.getRange(r, 1, 2, 1).merge(); sh.getRange(r, 2, 2, 1).merge(); sh.getRange(r, 3, 2, 1).merge();
    sh.getRange(r + 1, 4, 1, n).setBorder(false, false, true, false, false, false);
  }
  dates.forEach(function (x, i) {
    var w = new Date(x + 'T00:00:00').getDay();
    var col = sh.getRange(1, 4 + i, values.length, 1);
    if (w === 0 || hol[x]) col.setBackground('#e6e6e6');
    if (duty[x]) sh.getRange(1, 4 + i).setBackground('#222222').setFontColor('#ffffff');
  });
  sh.setColumnWidth(1, 90); sh.setColumnWidth(2, 40); sh.setColumnWidth(3, 50);
  for (var c = 4; c < 4 + n; c++) sh.setColumnWidth(c, 34);
  sh.getRange(1, 1, values.length, values[0].length).setBorder(true, true, true, true, true, false, '#999999', SpreadsheetApp.BorderStyle.SOLID);
  sh.setFrozenRows(2); sh.setFrozenColumns(3);
  return ss.getUrl() + '#gid=' + sh.getSheetId();
}
