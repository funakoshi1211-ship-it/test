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
