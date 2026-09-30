"""毎営業日の発注指示書を作る。

入力: 最新の株価データ、保有中の建玉（positions.csv）、口座の資金
出力: 翌営業日の注文（売り・逆指値の変更・新規買い）を Markdown と CSV で書き出す

positions.csv の列:
  code,entry_date,entry_price,shares,stop,risk,highest
  （新規買いが約定したら、指示書の「約定後に positions.csv へ追記する行」をそのまま貼る）
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .backtest import Position, update_stop
from .strategy import Model, candidates, round_down, shares_for

POS_COLS = ["code", "entry_date", "entry_price", "shares", "stop", "risk", "highest"]


def load_positions(path: str | Path) -> list[Position]:
    p = Path(path)
    if not p.exists():
        return []
    df = pd.read_csv(p, dtype={"code": str})
    return [Position(r.code, pd.Timestamp(r.entry_date), float(r.entry_price), int(r.shares),
                     float(r.stop), float(r.risk), float(r.highest)) for r in df.itertuples()]


def make(m: Model, positions: list[Position], equity: float, cash: float, date=None) -> dict:
    cfg = m.cfg
    idx = m.w["close"].index
    date = pd.Timestamp(date) if date else idx[-1]
    i = idx.get_loc(date)
    close, atr = m.f["close"].iloc[i], m.f["atr"].iloc[i]
    sma = m.f[f"sma{cfg.exit_below_sma}"].iloc[i]
    sells, stops, keep = [], [], []

    for p in positions:
        c = close.get(p.code, np.nan)
        if not np.isfinite(c):
            stops.append({"code": p.code, "action": "価格データなし・要確認", "stop": p.stop})
            keep.append(p)
            continue
        held = idx[(idx > p.entry_date) & (idx <= date)]
        p.days = len(held)
        p.highest = max(p.highest, float(m.f["close"].loc[held, p.code].max()) if len(held) else c)
        new_stop, reason = update_stop(p, c, atr.get(p.code, np.nan), sma.get(p.code, np.nan), cfg)
        new_stop = round_down(new_stop)
        pl = (c / p.entry_price - 1)
        if reason:
            sells.append({"code": p.code, "name": m.names.get(p.code, ""), "shares": p.shares,
                          "order": "寄付き成行で売り", "reason": reason, "含み損益": f"{pl:+.1%}"})
        else:
            changed = new_stop > p.stop
            stops.append({"code": p.code, "name": m.names.get(p.code, ""), "shares": p.shares,
                          "action": "逆指値を引き上げ" if changed else "逆指値そのまま",
                          "stop": new_stop, "prev_stop": p.stop, "含み損益": f"{pl:+.1%}"})
            p.stop = new_stop
            keep.append(p)

    buys = []
    exposure = float(m.reg["exposure"].iloc[i]) if np.isfinite(m.reg["exposure"].iloc[i]) else 0.0
    slots = int(round(cfg.max_positions * exposure)) - len(keep)
    held_sectors = [m.sector.get(p.code, "不明") for p in keep]
    cand = candidates(m, date)
    remaining_cash = cash
    for r in cand.itertuples():
        if len(buys) >= slots:
            break
        if r.code in {p.code for p in keep}:
            continue
        if r.sector != "不明" and held_sectors.count(r.sector) >= cfg.max_per_sector:
            continue
        limit = round_down(r.close * (1 + cfg.entry_limit_pct))
        n = shares_for(equity, remaining_cash, limit, r.atr, cfg)
        if n <= 0:
            continue
        risk = cfg.stop_atr * r.atr
        remaining_cash -= n * limit
        held_sectors.append(r.sector)
        buys.append({
            "code": r.code, "name": r.name, "sector": r.sector, "shares": n,
            "order": "指値で買い（当日限り）", "limit": limit,
            "stop_after_fill": "約定値 − " + f"{risk:,.0f}円",
            "stop_if_filled_at_limit": round_down(limit - risk),
            "資金に占める割合": f"{n * limit / equity:.1%}",
            "score": r.score, "rs": r.rs, "rsi": r.rsi, "fund_score": r.fund_score, "risk": round(risk, 1),
        })

    reg = m.reg.iloc[i]
    return {"date": date, "exposure": exposure, "regime": reg, "sells": sells, "stops": stops,
            "buys": buys, "keep": keep, "candidates": cand}


def to_markdown(o: dict) -> str:
    d = o["date"]
    reg = o["regime"]
    mood = {1.0: "強気（通常どおり）", 0.5: "中立（保有枠を半分に）", 0.0: "弱気（新規買いなし）"}.get(o["exposure"], "")
    out = [f"# 発注指示書（{d:%Y-%m-%d} 終値基準 → 翌営業日の注文）", "",
           f"**市場環境**: {mood}　TOPIX {reg['topix']:,.1f}"]
    if "foreign_net" in reg and np.isfinite(reg.get("foreign_net", np.nan)):
        out.append(f"（海外投資家 直近の現物差引合計 {reg['foreign_net'] / 1e8:,.0f}億円）")
    out += ["", "## 1. 売り（最優先）"]
    out += [f"- {s['code']} {s['name']}：{s['shares']}株を**{s['order']}**　理由：{s['reason']}（{s['含み損益']}）"
            for s in o["sells"]] or ["- なし"]
    out += ["", "## 2. 保有株の逆指値（損切り）注文"]
    out += [f"- {s['code']} {s.get('name', '')}：{s['action']} → **{s['stop']:,.0f}円** 以下で売り"
            f"（前回 {s.get('prev_stop', s['stop']):,.0f}円／{s.get('含み損益', '')}）" for s in o["stops"]] or ["- なし"]
    out += ["", "## 3. 新規買い"]
    if not o["buys"]:
        out.append("- なし")
    for b in o["buys"]:
        out += [f"- **{b['code']} {b['name']}**（{b['sector']}）：{b['shares']}株を **{b['limit']:,.0f}円の指値**（当日限り）",
                f"  - 約定したら同日中に逆指値：{b['stop_after_fill']}（指値どおりなら {b['stop_if_filled_at_limit']:,.0f}円）",
                f"  - 根拠：スコア{b['score']}／対TOPIX超過{b['rs']:+.0%}／RSI{b['rsi']}／財務{b['fund_score']:.0f}点"]
    if o["buys"]:
        out += ["", "約定後に positions.csv へ追記する行（entry_price と stop は実際の約定値で直す）:", "```"]
        out += [f"{b['code']},{o['date'] + pd.offsets.BDay():%Y-%m-%d},{b['limit']},{b['shares']},"
                f"{b['stop_if_filled_at_limit']},{b['risk']},{b['limit']}" for b in o["buys"]]
        out.append("```")
    out += ["", "## ルール（守ること）",
            "- 寄付き前に1→2→3の順で発注。買いが約定しなかった場合は追いかけない",
            "- 逆指値は必ず証券会社に入れておく（自分で判断して外さない）",
            "- 決算・ニュースで判断を変えない。変えるなら、まずバックテストでルールとして検証する"]
    return "\n".join(out)


def save_positions(keep: list[Position], path: str | Path) -> None:
    pd.DataFrame([{c: getattr(p, c) for c in POS_COLS} for p in keep], columns=POS_COLS).to_csv(path, index=False)
