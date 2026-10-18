// このファイルは tools/build.js で gas/（Logic.gs・Defaults.gs・Code.gs）から自動生成しています。直接編集しないでください

/**
 * テーマレーダー（判定ロジック）
 * GAS の API を使わない計算だけを置く。Node のテスト（test/radar.test.js）からも読み込む。
 *
 * 考え方：1銘柄だけの急騰は、その会社だけの材料であることが多い。
 * 同じテーマの複数の銘柄が「市場平均より強く上がる」「出来高が増える」「高値を更新する」を
 * そろって起こしたら、テーマに資金が入り始めた（初動）とみなす。
 * 判定はその日までのデータだけで行う（先の値を使わない）ので、過去の検証にもそのまま使える。
 */
var Radar = (function () {
  var BASE = 60;          // 「普段」の出来高と値動きを測る営業日数
  var START = BASE + 6;   // 指標を出し始める位置（これより前は履歴が足りない）
  var STALE_DAYS = 5;     // 日付を合わせるとき、何日前のデータまで使うか（米国株や売買停止の日）

  var DEFAULTS = {
    benchJP: '1306.T',   // 日本株と比べるベンチマーク（TOPIX連動ETF）
    benchUS: 'SPY',      // 米国株と比べるベンチマーク
    igniteScore: 60,     // 熱量がこれ以上で「初動」「上昇中」
    quietScore: 45,      // 3〜10営業日前の熱量がずっとこれ未満なら「静かだった」。予兆の下限も兼ねる
    watchRise: 15,       // 予兆：熱量が5営業日前よりこれだけ上がった
    hotDev25: 0.20,      // 過熱：25日移動平均からの乖離（テーマ平均）
    surgeVol: 2.0,       // 出来高急増：当日の出来高が普段の何倍か（市場全体の増え方で割ったあと）
    minSurge: 2,         // 初動に必要な「出来高急増＋上昇」の銘柄数
    minMembers: 3,       // 判定に必要な銘柄数（データが取れたもの）
    cooldown: 10,        // 初動を出したあと、次の初動を出さない営業日数
    newsRatio: 2.5,      // ニュース急増：直近14日平均の何倍か
    newsMin: 5,          // ニュース急増とみなす最低件数
    notify: ['初動', '予兆', '過熱']
  };
  var STAGES = ['初動', '予兆', '上昇中', '過熱', '失速', ''];

  // 証券コードを Yahoo Finance の記号にする（4493 → 4493.T、153A → 153A.T、CRWD・1306.T はそのまま）
  function toSymbol(code) {
    var s = String(code == null ? '' : code)
      .replace(/[０-９Ａ-Ｚａ-ｚ．]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
      .trim().toUpperCase();
    return /^\d{3}[0-9A-Z]$/.test(s) ? s + '.T' : s;
  }

  function marketOf(symbol) {
    return /\.T$/.test(symbol) ? 'JP' : 'US';
  }

  // Yahoo Finance の chart API（v8）の応答を [{date, close, price, volume}] にする。
  // close は分割・配当を調整した終値（騰落の計算用）、price は表示用の終値
  function parseYahooChart(text) {
    var r;
    try { r = JSON.parse(text).chart.result[0]; } catch (e) { return []; }
    if (!r || !r.timestamp || !r.indicators || !r.indicators.quote) return [];
    var q = r.indicators.quote[0] || {}, adj = ((r.indicators.adjclose || [])[0] || {}).adjclose || [];
    var off = (r.meta && r.meta.gmtoffset) || 0, byDate = {};
    r.timestamp.forEach(function (ts, i) {
      var price = (q.close || [])[i], close = adj[i] != null ? adj[i] : price;
      if (!(close > 0)) return;
      // 取引所の現地時刻の日付にする。同じ日付が2本あるとき（取引中の足）は後のものを使う
      var d = new Date((ts + off) * 1000).toISOString().slice(0, 10);
      byDate[d] = { date: d, close: close, price: price > 0 ? price : close, volume: (q.volume || [])[i] || 0 };
    });
    return Object.keys(byDate).sort().map(function (d) { return byDate[d]; });
  }

  // ---------- 1銘柄の指標 ----------
  // bars：日付順 [{date, close, volume}]、bench：同じ市場のベンチマーク
  function stockFeatures(bars, bench) {
    var n = bars.length, c = [], v = [], out = [];
    bars.forEach(function (b) { c.push(b.close); v.push(b.volume || 0); out.push(null); });
    var bDates = (bench || []).map(function (b) { return b.date; });
    function bClose(d) { var k = asOfIdx_(bDates, d); return k < 0 ? null : bench[k].close; }
    function mktRet(i, k) { var a = bClose(bars[i].date), b = bClose(bars[i - k].date); return a && b ? a / b - 1 : 0; }
    // 普段の出来高：5営業日前までの60営業日の平均（直近の急増が「普段」に混ざらないようにする）
    var base = v.map(function (_, i) { return i >= BASE + 4 ? avg_(v, i - BASE - 4, i - 5) : 0; });
    var hi20 = c.map(function (x, i) { return i >= 19 && x >= Math.max.apply(null, c.slice(i - 19, i + 1)); });
    for (var i = START; i < n; i++) {
      var rets = [];
      for (var k = i - BASE; k < i; k++) rets.push(c[k] / c[k - 1] - 1);
      var sigma = std_(rets), x5 = c[i] / c[i - 5] - 1 - mktRet(i, 5);
      out[i] = {
        date: bars[i].date,
        price: bars[i].price || c[i],
        ret1: c[i] / c[i - 1] - 1,
        r5: c[i] / c[i - 5] - 1,
        x5: x5,                                     // 5日の騰落からベンチマークの騰落を引いたもの
        x20: c[i] / c[i - 20] - 1 - mktRet(i, 20),
        z5: sigma > 0 ? x5 / (sigma * Math.sqrt(5)) : 0,   // いつもの値動きの何倍、市場より強かったか
        vr1: base[i] > 0 ? v[i] / base[i] : null,
        vr5: base[i] > 0 ? avg_(v, i - 4, i) / base[i] : null,
        hi20: hi20[i],
        dev25: c[i] / avg_(c, i - 24, i) - 1
      };
    }
    return out;
  }

  // 出来高を市場全体の増え方で割る（暴落の日やSQの日など、全銘柄の出来高が増える日を合図にしないため）。
  // あわせて「直近3日に出来高急増＋上昇」「直近3日に20日高値」を付ける
  function relativize_(list, cfg) {
    var med = {};
    list.forEach(function (s) {
      s.feats.forEach(function (f) {
        if (!f || f.vr5 == null) return;
        var key = s.market + '|' + f.date;
        if (!med[key]) med[key] = { vr1: [], vr5: [] };
        med[key].vr1.push(f.vr1);
        med[key].vr5.push(f.vr5);
      });
    });
    Object.keys(med).forEach(function (key) {
      var m = med[key];
      med[key] = m.vr5.length >= 8 ? { vr1: median_(m.vr1), vr5: median_(m.vr5) } : null;   // 銘柄が少ない市場は割らない
    });
    list.forEach(function (s) {
      s.feats.forEach(function (f) {
        if (!f) return;
        var m = med[s.market + '|' + f.date];
        f.rv1 = f.vr1 == null ? null : f.vr1 / (m && m.vr1 > 0 ? m.vr1 : 1);
        f.rv5 = f.vr5 == null ? null : f.vr5 / (m && m.vr5 > 0 ? m.vr5 : 1);
      });
      s.feats.forEach(function (f, i) {
        if (!f) return;
        var recent = [f, s.feats[i - 1], s.feats[i - 2]].filter(Boolean);
        f.surge = f.x5 > 0 && recent.some(function (g) { return g.rv1 >= cfg.surgeVol; });
        f.recentHigh = recent.some(function (g) { return g.hi20; });
      });
    });
  }

  // ---------- テーマの指標 ----------
  // 熱量（0〜100）＝ 強さ35点 ＋ 出来高25点 ＋ 高値更新25点 ＋ 上昇の広がり15点。
  // 強さと出来高はテーマの上位半数の平均を使う（一部の銘柄だけが先に動く初動を拾うため。
  // 1銘柄だけでは半分しか効かないので、単独の急騰では上がりきらない）
  function aggregate_(fs) {
    var n = fs.length;
    if (!n) return null;
    var top = Math.ceil(n / 2);
    var zTop = mean_(fs.map(function (f) { return clip_(f.z5, -5, 5); }).sort(desc_).slice(0, top));
    var vTop = mean_(fs.map(function (f) { return clip_(f.rv5 == null ? 1 : f.rv5, 0, 5); }).sort(desc_).slice(0, top));
    var hi = count_(fs, function (f) { return f.recentHigh; }), up = count_(fs, function (f) { return f.x5 > 0; });
    var score = 100 * (0.35 * clip_(zTop / 2, 0, 1) + 0.25 * clip_(vTop - 1, 0, 1) + 0.25 * hi / n + 0.15 * up / n);
    return {
      n: n, score: Math.round(score), zTop: zTop, vTop: vTop, hi: hi, up: up,
      surge: count_(fs, function (f) { return f.surge; }),
      volUp: count_(fs, function (f) { return f.rv5 >= 1.5; }),
      x5: mean_(fs.map(function (f) { return f.x5; })),
      x20: mean_(fs.map(function (f) { return f.x20; })),
      dev25: mean_(fs.map(function (f) { return f.dev25; }))
    };
  }

  // 日ごとの状態。t の判定には t までのデータしか使わない
  function classify_(series, cfg) {
    var out = [];
    for (var t = 0; t < series.length; t++) {
      var f = series[t], st = '', kind = '';
      if (f && f.n >= cfg.minMembers) {
        var before = scores_(series, t - 10, t - 3), peak = Math.max.apply(null, scores_(series, t - 10, t - 1).concat([0]));
        var quiet = before.length >= 5 && Math.max.apply(null, before) < cfg.quietScore;
        var ignitedLately = out.slice(Math.max(0, t - cfg.cooldown), t).some(function (o) { return o.stage === '初動'; });
        var s5 = series[t - 5] ? series[t - 5].score : null;
        if (f.score >= cfg.igniteScore && quiet && f.surge >= cfg.minSurge && !ignitedLately) st = '初動';
        else if (f.dev25 >= cfg.hotDev25) st = '過熱';
        else if (f.score >= cfg.igniteScore) st = '上昇中';
        else if (peak >= cfg.igniteScore && f.score < cfg.quietScore) st = '失速';
        // 熱量の上昇だけだと偶然の値動きでもよく出るので、出来高急増の銘柄が1つはあることを条件にする
        else if (f.score >= cfg.quietScore && s5 != null && f.score - s5 >= cfg.watchRise && f.surge >= 1) { st = '予兆'; kind = 'rise'; }
        else if (f.volUp * 2 >= f.n && Math.abs(f.x5) < 0.03) { st = '予兆'; kind = 'volume'; }
      }
      out.push({ stage: st, kind: kind });
    }
    return out;
  }

  // 前の5営業日に同じ状態がなければ「新しく出た」合図
  function fresh_(stages, t, stage) {
    if (!stage) return false;
    for (var k = 1; k <= 5 && t - k >= 0; k++) if (stages[t - k].stage === stage) return false;
    return true;
  }

  function reason_(stage, kind, f, s5, peak, nw) {
    if (!f) return 'データ不足';
    switch (stage) {
      case '初動': return f.n + '銘柄中' + f.surge + '銘柄で出来高急増、' + f.hi + '銘柄が20日高値。直前2週間は静かだった';
      case '予兆':
        if (kind === 'news') return 'ニュースが普段の' + nw.ratio.toFixed(1) + '倍（' + nw.count + '件）。株価はまだ大きく動いていない';
        if (kind === 'volume') return '株価はまだ動かず、' + f.n + '銘柄中' + f.volUp + '銘柄で出来高が普段の1.5倍超';
        return '熱量が5日で' + s5 + '→' + f.score + 'に上昇';
      case '上昇中': return '5日で市場比' + pct_(f.x5) + '、' + f.n + '銘柄中' + f.hi + '銘柄が高値圏';
      case '過熱': return '25日線から平均' + pct_(f.dev25) + '離れている。高値づかみに注意';
      case '失速': return '熱量が' + peak + '→' + f.score + 'に低下';
      default: return '';
    }
  }

  // ---------- 全体 ----------
  // input: { members: [{theme, code, name}], bars: {記号: [{date, close, price, volume}]},
  //          news: {テーマ: {count, ratio}} }（news は省略可）
  // opts: DEFAULTS の上書き
  function analyze(input, opts) {
    var cfg = {};
    Object.keys(DEFAULTS).forEach(function (k) { cfg[k] = opts && opts[k] != null && opts[k] !== '' ? opts[k] : DEFAULTS[k]; });
    var bars = input.bars || {}, news = input.news || {};
    var bench = { JP: toSymbol(cfg.benchJP), US: toSymbol(cfg.benchUS) };
    var members = (input.members || []).map(function (m) {
      var sym = toSymbol(m.code);
      return { theme: String(m.theme), code: String(m.code), name: m.name || sym, symbol: sym, market: marketOf(sym) };
    }).filter(function (m) { return m.theme && m.symbol; });

    var feats = {}, list = [];
    members.forEach(function (m) {
      if (feats[m.symbol] || !bars[m.symbol] || bars[m.symbol].length <= START) return;
      var b = bars[m.symbol];
      feats[m.symbol] = { market: m.market, dates: b.map(function (x) { return x.date; }), feats: stockFeatures(b, bars[bench[m.market]]) };
      list.push(feats[m.symbol]);
    });
    relativize_(list, cfg);

    // 日付の軸：日本株ベンチマークの営業日（取れなかったときは全銘柄の日付を合わせる）
    var axis = (bars[bench.JP] || []).map(function (x) { return x.date; });
    if (!axis.length) {
      var seen = {};
      list.forEach(function (s) { s.dates.forEach(function (d) { seen[d] = 1; }); });
      axis = Object.keys(seen).sort();
    }
    function featAt(sym, d) {
      var s = feats[sym];
      if (!s) return null;
      var k = asOfIdx_(s.dates, d);
      return k < 0 ? null : s.feats[k];
    }

    var themes = [], byTheme = {};
    members.forEach(function (m) {
      if (!byTheme[m.theme]) { byTheme[m.theme] = []; themes.push(m.theme); }
      byTheme[m.theme].push(m);
    });
    var series = {}, stages = {};
    themes.forEach(function (th) {
      series[th] = axis.map(function (d) {
        return aggregate_(byTheme[th].map(function (m) { return featAt(m.symbol, d); }).filter(Boolean));
      });
      stages[th] = classify_(series[th], cfg);
    });

    var t = axis.length - 1, date = axis[t] || '';
    var rows = themes.map(function (th) {
      var f = series[th][t] || null, st = stages[th][t] || { stage: '', kind: '' };
      var stage = st.stage, kind = st.kind, nw = news[th] || null;
      var newsHot = nw && nw.ratio != null && nw.ratio >= cfg.newsRatio && nw.count >= cfg.newsMin;
      if (!stage && newsHot && f && f.n >= cfg.minMembers) { stage = '予兆'; kind = 'news'; }
      var s5 = series[th][t - 5] ? series[th][t - 5].score : null;
      var peak = Math.max.apply(null, scores_(series[th], t - 10, t - 1).concat([0]));
      var leaders = byTheme[th].map(function (m) { return { m: m, f: featAt(m.symbol, date) }; })
        .filter(function (x) { return x.f && x.f.r5 > 0; })
        .sort(function (a, b) { return b.f.r5 - a.f.r5; }).slice(0, 3)
        .map(function (x) { return x.m.name + ' ' + pct_(x.f.r5); });
      var spark = [], last = 0;
      for (var k = Math.max(0, t - 29); k <= t; k++) { if (series[th][k]) last = series[th][k].score; spark.push(last); }
      return {
        theme: th, stage: stage, kind: kind, fresh: fresh_(stages[th], t, stage),
        score: f ? f.score : null, score5: s5, f: f, news: nw, leaders: leaders, spark: spark,
        reason: reason_(stage, kind, f, s5, peak, nw)
      };
    });
    rows.sort(function (a, b) {
      return STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || (b.score || 0) - (a.score || 0);
    });

    var stageOf = {};
    rows.forEach(function (r) { stageOf[r.theme] = r.stage; });
    var stocks = members.map(function (m) {
      var f = featAt(m.symbol, date), flags = [];
      if (f) {
        if (f.z5 >= 2.5) flags.push('急騰');
        if (f.rv1 >= cfg.surgeVol) flags.push('出来高急増');
        if (f.rv5 >= 1.8 && Math.abs(f.x5) < 0.03) flags.push('出来高先行');
        if (f.hi20) flags.push('20日高値');
        if (f.dev25 >= 0.25) flags.push('過熱');
        if ((stageOf[m.theme] === '初動' || stageOf[m.theme] === '上昇中') && f.z5 < 0.5 && f.rv5 >= 1.2) flags.push('テーマ内で未上昇（出来高は増加）');
      }
      return { theme: m.theme, code: m.code, name: m.name, symbol: m.symbol, f: f, flags: flags };
    });

    var histDates = axis.slice(Math.max(0, axis.length - 60));
    var history = {
      dates: histDates,
      rows: themes.map(function (th) {
        return [th].concat(series[th].slice(axis.length - histDates.length).map(function (f) { return f ? f.score : ''; }));
      })
    };

    var notify = cfg.notify || [];
    return {
      date: date,
      themes: rows,
      stocks: stocks,
      history: history,
      alerts: rows.filter(function (r) { return r.fresh && notify.indexOf(r.stage) >= 0; }),
      missing: members.filter(function (m) { return !feats[m.symbol]; }).map(function (m) { return m.symbol; }),
      benchMissing: Object.keys(bench).filter(function (k) {
        return !bars[bench[k]] && members.some(function (m) { return m.market === k; });
      }).map(function (k) { return bench[k]; }),
      backtest: backtest_(themes, byTheme, series, stages, axis, bars, bench)
    };
  }

  // ---------- 過去の検証 ----------
  // 合図の日の終値から k 営業日後までの、テーマ平均の「ベンチマークとの差」
  function backtest_(themes, byTheme, series, stages, axis, bars, bench) {
    var idx = {};
    function closeAt(sym, d) {
      var b = bars[sym];
      if (!b) return null;
      if (!idx[sym]) idx[sym] = b.map(function (x) { return x.date; });
      var k = asOfIdx_(idx[sym], d);
      return k < 0 ? null : b[k].close;
    }
    function fwd(th, t, k) {
      if (t + k >= axis.length) return null;
      var d0 = axis[t], d1 = axis[t + k], xs = [];
      byTheme[th].forEach(function (m) {
        var a = closeAt(m.symbol, d0), b = closeAt(m.symbol, d1);
        if (!a || !b) return;
        var ba = closeAt(bench[m.market], d0), bb = closeAt(bench[m.market], d1);
        xs.push(b / a - 1 - (ba && bb ? bb / ba - 1 : 0));
      });
      return xs.length ? mean_(xs) : null;
    }
    var events = [], all = [];
    themes.forEach(function (th) {
      for (var t = 0; t < axis.length; t++) {
        var f = series[th][t];
        if (!f) continue;
        var f10 = fwd(th, t, 10);
        if (f10 != null) all.push({ f5: fwd(th, t, 5), f10: f10, f20: fwd(th, t, 20) });
        var st = stages[th][t];
        if ((st.stage === '初動' || st.stage === '予兆') && fresh_(stages[th], t, st.stage)) {
          events.push({
            date: axis[t], theme: th, stage: st.stage, score: f.score,
            f5: fwd(th, t, 5), f10: f10, f20: fwd(th, t, 20),
            reason: reason_(st.stage, st.kind, f, series[th][t - 5] ? series[th][t - 5].score : null, 0, null)
          });
        }
      }
    });
    events.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    function summary(xs) {
      var f10 = xs.filter(function (x) { return x.f10 != null; });
      function avgOf(key) {
        var v = xs.filter(function (x) { return x[key] != null; }).map(function (x) { return x[key]; });
        return v.length ? mean_(v) : null;
      }
      return {
        count: xs.length, f5: avgOf('f5'), f10: avgOf('f10'), f20: avgOf('f20'),
        win10: f10.length ? count_(f10, function (x) { return x.f10 > 0; }) / f10.length : null
      };
    }
    return {
      events: events,
      ignite: summary(events.filter(function (e) { return e.stage === '初動'; })),
      watch: summary(events.filter(function (e) { return e.stage === '予兆'; })),
      baseline: summary(all)
    };
  }

  // ---------- 小道具 ----------
  // dates（昇順）の中で d 以前の最後の位置。STALE_DAYS より古ければ -1
  function asOfIdx_(dates, d) {
    var lo = 0, hi = dates.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (dates[mid] <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans < 0 || (Date.parse(d) - Date.parse(dates[ans])) / 86400000 > STALE_DAYS) return -1;
    return ans;
  }
  function scores_(series, from, to) {
    var out = [];
    for (var i = Math.max(0, from); i <= to; i++) if (series[i]) out.push(series[i].score);
    return out;
  }
  function avg_(a, from, to) { var s = 0; for (var i = from; i <= to; i++) s += a[i]; return s / (to - from + 1); }
  function mean_(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
  function std_(a) { var m = mean_(a); return Math.sqrt(mean_(a.map(function (x) { return (x - m) * (x - m); }))); }
  function median_(a) { var b = a.slice().sort(function (x, y) { return x - y; }), h = b.length >> 1; return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2; }
  function clip_(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function count_(a, fn) { return a.filter(fn).length; }
  function desc_(x, y) { return y - x; }
  function pct_(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }

  return {
    DEFAULTS: DEFAULTS, STAGES: STAGES,
    toSymbol: toSymbol, marketOf: marketOf, parseYahooChart: parseYahooChart,
    stockFeatures: stockFeatures, analyze: analyze, pct: pct_
  };
})();

/**
 * テーマレーダー（初期データ）
 * 初期設定で「テーマ銘柄」「ニュース語」シートが空のときに書き込む。あとはシートで自由に足し引きする。
 * 同じ銘柄を複数のテーマに入れてもよい。
 */
var DEFAULT_MEMBERS = [
  ['サイバーセキュリティ', '4704', 'トレンドマイクロ'],
  ['サイバーセキュリティ', '2326', 'デジタルアーツ'],
  ['サイバーセキュリティ', '3857', 'ラック'],
  ['サイバーセキュリティ', '4493', 'サイバーセキュリティクラウド'],
  ['サイバーセキュリティ', '3692', 'FFRIセキュリティ'],
  ['サイバーセキュリティ', '4417', 'グローバルセキュリティエキスパート'],
  ['サイバーセキュリティ', '3042', 'セキュアヴェイル'],
  ['サイバーセキュリティ', '153A', 'カウリス'],
  ['サイバーセキュリティ', '3040', 'ソリトンシステムズ'],
  ['サイバーセキュリティ', '4398', 'ブロードバンドセキュリティ'],

  ['半導体製造装置', '8035', '東京エレクトロン'],
  ['半導体製造装置', '6857', 'アドバンテスト'],
  ['半導体製造装置', '6146', 'ディスコ'],
  ['半導体製造装置', '6920', 'レーザーテック'],
  ['半導体製造装置', '7735', 'SCREENホールディングス'],
  ['半導体製造装置', '6525', 'KOKUSAI ELECTRIC'],
  ['半導体製造装置', '6323', 'ローツェ'],
  ['半導体製造装置', '6315', 'TOWA'],

  ['生成AI', '9984', 'ソフトバンクグループ'],
  ['生成AI', '3993', 'PKSHA Technology'],
  ['生成AI', '4180', 'Appier Group'],
  ['生成AI', '5574', 'ABEJA'],
  ['生成AI', '4488', 'AI inside'],
  ['生成AI', '3778', 'さくらインターネット'],
  ['生成AI', '5572', 'Ridge-i'],

  ['電線・データセンター', '5801', '古河電気工業'],
  ['電線・データセンター', '5802', '住友電気工業'],
  ['電線・データセンター', '5803', 'フジクラ'],
  ['電線・データセンター', '5805', 'SWCC'],

  ['防衛', '7011', '三菱重工業'],
  ['防衛', '7012', '川崎重工業'],
  ['防衛', '7013', 'IHI'],
  ['防衛', '6203', '豊和工業'],
  ['防衛', '7721', '東京計器'],
  ['防衛', '6946', '日本アビオニクス'],
  ['防衛', '6208', '石川製作所'],
  ['防衛', '4274', '細谷火工'],

  ['原発・電力', '9501', '東京電力ホールディングス'],
  ['原発・電力', '9503', '関西電力'],
  ['原発・電力', '9506', '東北電力'],
  ['原発・電力', '5631', '日本製鋼所'],
  ['原発・電力', '6378', '木村化工機'],
  ['原発・電力', '6330', '東洋エンジニアリング'],

  ['量子コンピューター', '6702', '富士通'],
  ['量子コンピューター', '6701', 'NEC'],
  ['量子コンピューター', '3687', 'フィックスターズ'],
  ['量子コンピューター', '2667', 'イメージ ワン'],

  ['宇宙', '186A', 'アストロスケールホールディングス'],
  ['宇宙', '9348', 'ispace'],
  ['宇宙', '5595', 'QPS研究所'],
  ['宇宙', '290A', 'Synspective'],
  ['宇宙', '7011', '三菱重工業'],

  ['銀行（金利上昇）', '8306', '三菱UFJフィナンシャル・グループ'],
  ['銀行（金利上昇）', '8316', '三井住友フィナンシャルグループ'],
  ['銀行（金利上昇）', '8411', 'みずほフィナンシャルグループ'],
  ['銀行（金利上昇）', '8308', 'りそなホールディングス'],
  ['銀行（金利上昇）', '7182', 'ゆうちょ銀行'],

  ['インバウンド', '3099', '三越伊勢丹ホールディングス'],
  ['インバウンド', '8233', '高島屋'],
  ['インバウンド', '4661', 'オリエンタルランド'],
  ['インバウンド', '9603', 'エイチ・アイ・エス'],
  ['インバウンド', '9201', '日本航空'],
  ['インバウンド', '7532', 'パン・パシフィック・インターナショナルHD'],

  ['ゲーム・エンタメ', '7974', '任天堂'],
  ['ゲーム・エンタメ', '6758', 'ソニーグループ'],
  ['ゲーム・エンタメ', '9697', 'カプコン'],
  ['ゲーム・エンタメ', '9766', 'コナミグループ'],
  ['ゲーム・エンタメ', '9684', 'スクウェア・エニックスHD'],
  ['ゲーム・エンタメ', '5032', 'ANYCOLOR'],

  ['ロボット・FA', '6954', 'ファナック'],
  ['ロボット・FA', '6506', '安川電機'],
  ['ロボット・FA', '6861', 'キーエンス'],
  ['ロボット・FA', '6324', 'ハーモニック・ドライブ・システムズ'],
  ['ロボット・FA', '6268', 'ナブテスコ'],

  ['電子部品', '6981', '村田製作所'],
  ['電子部品', '6762', 'TDK'],
  ['電子部品', '6971', '京セラ'],
  ['電子部品', '6976', '太陽誘電'],
  ['電子部品', '6963', 'ローム'],

  ['商社', '8058', '三菱商事'],
  ['商社', '8001', '伊藤忠商事'],
  ['商社', '8031', '三井物産'],
  ['商社', '8053', '住友商事'],
  ['商社', '8002', '丸紅'],

  ['海運', '9101', '日本郵船'],
  ['海運', '9104', '商船三井'],
  ['海運', '9107', '川崎汽船'],
  ['海運', '9119', '飯野海運'],

  ['自動車', '7203', 'トヨタ自動車'],
  ['自動車', '7267', '本田技研工業'],
  ['自動車', '7201', '日産自動車'],
  ['自動車', '7269', 'スズキ'],
  ['自動車', '7270', 'SUBARU'],
  ['自動車', '6902', 'デンソー'],

  ['建設・国土強靱化', '1801', '大成建設'],
  ['建設・国土強靱化', '1802', '大林組'],
  ['建設・国土強靱化', '1812', '鹿島建設'],
  ['建設・国土強靱化', '1803', '清水建設'],
  ['建設・国土強靱化', '1721', 'コムシスホールディングス'],

  ['医薬品', '4502', '武田薬品工業'],
  ['医薬品', '4568', '第一三共'],
  ['医薬品', '4519', '中外製薬'],
  ['医薬品', '4523', 'エーザイ'],
  ['医薬品', '4503', 'アステラス製薬'],

  ['鉄鋼・非鉄', '5401', '日本製鉄'],
  ['鉄鋼・非鉄', '5411', 'JFEホールディングス'],
  ['鉄鋼・非鉄', '5406', '神戸製鋼所'],
  ['鉄鋼・非鉄', '5713', '住友金属鉱山'],
  ['鉄鋼・非鉄', '5706', '三井金属']
];

// Googleニュースで直近24時間の記事数を数える語。毎日100件に張り付く語は広すぎるので絞る
var DEFAULT_NEWS = [
  ['サイバーセキュリティ', '不正アクセス OR 情報漏えい OR サイバー攻撃 OR ランサムウェア'],
  ['半導体製造装置', '半導体製造装置'],
  ['生成AI', '生成AI 関連株'],
  ['電線・データセンター', 'データセンター 電力'],
  ['防衛', '防衛費 OR 防衛装備'],
  ['原発・電力', '原発 再稼働 OR 次世代革新炉'],
  ['量子コンピューター', '量子コンピューター'],
  ['宇宙', 'ロケット 打ち上げ OR 宇宙ビジネス'],
  ['銀行（金利上昇）', '日銀 利上げ'],
  ['インバウンド', '訪日客'],
  ['海運', '海運 運賃']
];

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
