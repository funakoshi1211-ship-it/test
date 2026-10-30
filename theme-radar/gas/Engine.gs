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
