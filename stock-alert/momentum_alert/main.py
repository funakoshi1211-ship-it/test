"""毎日1回動かし、新しく「動き始めた」銘柄・テーマ・話題を通知する。

  python -m momentum_alert.main            # 取得→判定→通知
  python -m momentum_alert.main --dry-run  # 通知せず画面に出すだけ
  python -m momentum_alert.main --no-news  # ニュースを見ない
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import date, datetime
from pathlib import Path

import yaml

from . import data, news, notify
from .signals import STAGE_EARLY, STAGE_LATE, STAGE_MID, evaluate, theme_summary

ROOT = Path(__file__).resolve().parent.parent
STAGE_RANK = {STAGE_EARLY: 1, STAGE_MID: 2, STAGE_LATE: 3}


def load_config(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"alerts": {}, "news_history": {}}


def is_new(state: dict, key: str, stg: str, today: date, cooldown: int) -> bool:
    """初めて／段階が上がった／前回から cooldown 日以上たった ときだけ通知する。"""
    prev = state["alerts"].get(key)
    if not prev:
        return True
    if STAGE_RANK.get(stg, 0) > STAGE_RANK.get(prev["stage"], 0):
        return True
    return (today - date.fromisoformat(prev["date"])).days >= cooldown


def liquid(row, ticker: str, th: dict) -> bool:
    limit = th["min_yen_volume"] if data.is_jp(ticker) else th["min_dollar_volume"]
    return row["dollar_vol"] >= limit


def analyze(cfg: dict, prices: dict) -> tuple[list[dict], list[dict]]:
    th = cfg["thresholds"]
    bench = {k: prices[t]["Close"] for k, t in cfg["benchmarks"].items() if t in prices}
    stocks, themes, done = [], [], set()
    for name, spec in cfg["themes"].items():
        latest, etf_latest = {}, {}
        for t in spec.get("tickers", []) + spec.get("etf", []):
            if t not in prices:
                continue
            b = bench.get("jp" if data.is_jp(t) else "us")
            if b is None:
                continue
            row = evaluate(prices[t], b, th).iloc[-1]
            if t in spec.get("etf", []):
                etf_latest[t] = row
                continue
            latest[t] = row
            if t not in done and row["stage"] and liquid(row, t, th):
                done.add(t)
                stocks.append({"ticker": t, "theme": name, **row.to_dict()})
        summary = theme_summary(name, latest, etf_latest, th)
        if summary:
            themes.append(summary)
    stocks.sort(key=lambda s: (STAGE_RANK[s["stage"]], -s["score"]))
    return stocks, themes


def add_news(cfg: dict, themes: list[dict], state: dict) -> None:
    th = cfg["thresholds"]
    hist = state.setdefault("news_history", {})
    for t in themes:
        queries = cfg["themes"][t["theme"]].get("news") or []
        if not queries:
            continue
        buzz = news.theme_buzz(queries, hist.get(t["theme"], []), th)
        t["news"] = buzz
        hist[t["theme"]] = (hist.get(t["theme"], []) + [buzz["count24h"]])[-30:]


def fmt_pct(x: float) -> str:
    return f"{x:+.1f}%"


def build_report(stocks: list[dict], themes: list[dict], state: dict, today: date, cooldown: int) -> tuple[str, int]:
    lines, n_new = [], 0
    lines.append(f"モメンタム・アラート {today.isoformat()}")
    lines.append("※機械的なシグナルです。売買の判断はご自身で。過熱段階は追いかけ買いに注意。\n")

    def mark(key: str, stg: str) -> str:
        nonlocal n_new
        if is_new(state, key, stg, today, cooldown):
            state["alerts"][key] = {"stage": stg, "date": today.isoformat()}
            n_new += 1
            return "🆕 "
        return ""

    hot = [t for t in themes if t["triggered"]]
    buzz_only = [t for t in themes if not t["triggered"] and t.get("news", {}).get("surge")]
    if hot:
        lines.append("■ テーマ全体が動き始めている")
        for t in sorted(hot, key=lambda x: STAGE_RANK[x["stage"]]):
            nb = t.get("news", {})
            both = " ★話題も急増" if nb.get("surge") else ""
            lines.append(f"{mark('theme:' + t['theme'], t['stage'])}[{t['stage']}] {t['theme']}{both}")
            lines.append(f"   上昇銘柄の割合 {t['breadth']:.0%}（{t['n']}銘柄）／指数比 10日 {fmt_pct(t['med_rs10'])}・"
                         f"5日 {fmt_pct(t['med_rs5'])}／20日上昇 {fmt_pct(t['med_ret20'])}")
            if t["etf_breakouts"]:
                lines.append(f"   ETF高値更新: {', '.join(t['etf_breakouts'])}")
            lines.append("   主な銘柄: " + ", ".join(f"{tk}({sc:.0f}{'・' + st if st else ''})" for tk, sc, st in t["leaders"]))
            _news_lines(lines, nb)
        lines.append("")
    if buzz_only:
        lines.append("■ 話題が先行（ニュース急増・株価はまだ）")
        for t in buzz_only:
            lines.append(f"{mark('buzz:' + t['theme'], STAGE_EARLY)}{t['theme']}")
            _news_lines(lines, t["news"])
        lines.append("")
    if stocks:
        lines.append("■ 個別銘柄（点数順）")
        for s in stocks:
            lines.append(
                f"{mark('stock:' + s['ticker'], s['stage'])}[{s['stage']}] {s['ticker']}（{s['theme']}）"
                f" 点数{s['score']:.0f} 終値{s['close']:,.2f}"
                f" 指数比10日{fmt_pct(s['rs10'])} 出来高{s['vol_ratio']:.1f}倍"
                f" 20日{fmt_pct(s['ret20'])} RSI{s['rsi']:.0f}{' 高値更新' if s['breakout'] else ''}")
    if not (hot or buzz_only or stocks):
        lines.append("今日は条件に合う銘柄・テーマはありません。")
    return "\n".join(lines), n_new


def _news_lines(lines: list[str], nb: dict) -> None:
    if not nb:
        return
    lines.append(f"   ニュース24時間 {nb['count24h']}件（普段 {nb['baseline']}件/日）")
    for h in nb.get("headlines", []):
        src = f"（{h['source']}）" if h["source"] else ""
        lines.append(f"     - {h['title']}{src} {h['link']}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--state", default=str(ROOT / "state" / "state.json"))
    ap.add_argument("--report", default=str(ROOT / "state" / "report.txt"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-news", action="store_true")
    args = ap.parse_args()

    cfg = load_config(Path(args.config))
    state_path = Path(args.state)
    state = load_state(state_path)
    th = cfg["thresholds"]

    tickers = list(cfg["benchmarks"].values())
    for spec in cfg["themes"].values():
        tickers += spec.get("tickers", []) + spec.get("etf", [])
    prices = data.download(tickers)
    if not prices:
        raise SystemExit("株価を1つも取得できませんでした")

    stocks, themes = analyze(cfg, prices)
    if not args.no_news:
        add_news(cfg, themes, state)
    today = datetime.now().date()
    report, n_new = build_report(stocks, themes, state, today, th["cooldown_days"])
    print(report)

    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(report, encoding="utf-8")
    if summary := os.getenv("GITHUB_STEP_SUMMARY"):
        with open(summary, "a", encoding="utf-8") as f:
            f.write("```\n" + report + "\n```\n")

    if args.dry_run:
        return
    if n_new:
        sent = notify.send_all(f"【株アラート】新規 {n_new}件 {today.isoformat()}", report)
        print(f"[notify] 送信先: {sent or 'なし（通知先が未設定）'}")
    else:
        print("[notify] 新しいアラートがないため通知しません")
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
