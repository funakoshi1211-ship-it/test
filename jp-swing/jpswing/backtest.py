"""過去データでの検証。発注ツール（orders.py）と同じルールで売買を再現する。

約定の前提:
  - シグナルは当日の終値で判定し、翌営業日の寄付きで約定
  - 買いは指値（前日終値 × (1 + entry_limit_pct)）。寄付きが指値より高ければ見送り
  - 損切りは逆指値。寄付きで下回っていれば寄付き値、日中に触れれば逆指値の値で約定
  - 片道 cost_per_side の取引コストを差し引く
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .config import Config
from .strategy import Model, shares_for


@dataclass
class Position:
    code: str
    entry_date: pd.Timestamp
    entry_price: float
    shares: int
    stop: float
    risk: float               # 1株あたりの初期リスク（=1R）
    highest: float
    days: int = 0
    exit_next: str | None = None


def update_stop(p: Position, close: float, atr: float, sma: float, cfg: Config) -> tuple[float, str | None]:
    """終値確定後の損切り価格の更新と、翌日寄付きで手仕舞うべきかの判定。"""
    stop = p.stop
    if np.isfinite(atr):
        stop = max(stop, p.highest - cfg.trail_atr * atr)
    if p.highest >= p.entry_price + cfg.breakeven_r * p.risk:
        stop = max(stop, p.entry_price)
    reason = None
    if cfg.take_profit_r > 0 and close >= p.entry_price + cfg.take_profit_r * p.risk:
        reason = "利確目標"
    elif np.isfinite(sma) and close < sma:
        reason = f"{cfg.exit_below_sma}日線割れ"
    elif p.days >= cfg.max_hold_days:
        reason = "保有期間上限"
    return stop, reason


@dataclass
class Result:
    equity: pd.Series
    trades: pd.DataFrame
    stats: dict = field(default_factory=dict)
    yearly: pd.DataFrame | None = None


def run(m: Model, start=None, end=None, capital: float = 3_000_000) -> Result:
    cfg = m.cfg
    idx = m.w["close"].index
    lo = idx.searchsorted(pd.Timestamp(start)) if start else 250
    lo = max(lo, 1)
    hi = idx.searchsorted(pd.Timestamp(end), side="right") if end else len(idx)
    cols = m.w["close"].columns
    col = {c: j for j, c in enumerate(cols)}
    O, L, C = m.w["open"].values, m.w["low"].values, m.w["close"].values
    ATR, SMA = m.f["atr"].values, m.f[f"sma{cfg.exit_below_sma}"].values if f"sma{cfg.exit_below_sma}" in m.f else m.f["sma50"].values
    exposure = m.reg["exposure"].values
    sector = m.sector

    cash, positions, trades, curve = capital, {}, [], []
    pending: list = []  # 前日終値で選ばれた買い候補

    def close_pos(p: Position, px: float, date, reason: str):
        nonlocal cash
        proceeds = p.shares * px * (1 - cfg.cost_per_side)
        cash += proceeds
        cost = p.shares * p.entry_price * (1 + cfg.cost_per_side)
        trades.append({"code": p.code, "entry_date": p.entry_date, "exit_date": date,
                       "entry": p.entry_price, "exit": px, "shares": p.shares, "days": p.days,
                       "pnl": proceeds - cost, "ret": proceeds / cost - 1,
                       "r": (px - p.entry_price) / p.risk, "reason": reason})

    for i in range(lo, hi):
        date = idx[i]
        # 1) 寄付き：前日に決めた手仕舞い、逆指値
        for code in list(positions):
            p, j = positions[code], col[code]
            o, low = O[i, j], L[i, j]
            if not np.isfinite(o):  # 売買停止など
                continue
            if p.exit_next:
                close_pos(p, o, date, p.exit_next)
            elif o <= p.stop:
                close_pos(p, o, date, "損切り(窓開け)" if o < p.entry_price else "トレーリング利確")
            elif low <= p.stop:
                close_pos(p, p.stop, date, "損切り" if p.stop < p.entry_price else "トレーリング利確")
            else:
                continue
            del positions[code]

        # 2) 寄付き：新規買い
        equity_prev = curve[-1][1] if curve else capital
        slots = int(round(cfg.max_positions * exposure[i - 1])) if np.isfinite(exposure[i - 1]) else 0
        for code, limit, atr in pending:
            if len(positions) >= slots:
                break
            if code in positions:
                continue
            if sum(sector[c] == sector[code] for c in positions) >= cfg.max_per_sector and sector[code] != "不明":
                continue
            j = col[code]
            o = O[i, j]
            if not (np.isfinite(o) and o <= limit):
                continue
            n = shares_for(equity_prev, cash, o, atr, cfg)
            if n <= 0:
                continue
            cash -= n * o * (1 + cfg.cost_per_side)
            risk = cfg.stop_atr * atr
            positions[code] = Position(code, date, o, n, o - risk, risk, o)

        # 3) 大引け：損切り価格の更新、手仕舞い判定
        mv = 0.0
        for p in positions.values():
            j = col[p.code]
            c = C[i, j]
            if np.isfinite(c):
                p.days += 1
                p.highest = max(p.highest, c)
                p.stop, p.exit_next = update_stop(p, c, ATR[i, j], SMA[i, j], cfg)
                mv += p.shares * c
            else:
                mv += p.shares * p.entry_price
        curve.append((date, cash + mv))

        # 4) 大引け：翌日の買い候補
        pending = []
        if exposure[i] > 0:
            s = m.score.iloc[i].dropna().sort_values(ascending=False)
            for code in s.index[: cfg.max_positions * 3]:
                j = col[code]
                pending.append((code, C[i, j] * (1 + cfg.entry_limit_pct), ATR[i, j]))

    for p in list(positions.values()):  # 期末に残った建玉は終値で評価
        close_pos(p, C[hi - 1, col[p.code]], idx[hi - 1], "期末")

    eq = pd.Series(dict(curve)).sort_index()
    tr = pd.DataFrame(trades)
    return Result(eq, tr, stats(eq, tr, m.reg["topix"]), yearly(eq, tr))


def stats(eq: pd.Series, tr: pd.DataFrame, topix: pd.Series) -> dict:
    if len(eq) < 2:
        return {}
    yrs = (eq.index[-1] - eq.index[0]).days / 365.25
    dd = eq / eq.cummax() - 1
    r = eq.pct_change().dropna()
    tx = topix.reindex(eq.index).ffill()
    out = {
        "期間": f"{eq.index[0]:%Y-%m-%d}〜{eq.index[-1]:%Y-%m-%d}",
        "年率リターン": (eq.iloc[-1] / eq.iloc[0]) ** (1 / yrs) - 1 if yrs > 0 else np.nan,
        "TOPIX年率": (tx.iloc[-1] / tx.iloc[0]) ** (1 / yrs) - 1 if yrs > 0 else np.nan,
        "最大ドローダウン": dd.min(),
        "シャープレシオ": r.mean() / r.std() * np.sqrt(250) if r.std() > 0 else np.nan,
        "取引回数": len(tr),
    }
    if len(tr):
        win, loss = tr[tr["pnl"] > 0], tr[tr["pnl"] <= 0]
        out.update({
            "勝率": len(win) / len(tr),
            "平均利益(%)": win["ret"].mean() if len(win) else 0.0,
            "平均損失(%)": loss["ret"].mean() if len(loss) else 0.0,
            "損益比": win["ret"].mean() / -loss["ret"].mean() if len(win) and len(loss) else np.nan,
            "プロフィットファクター": win["pnl"].sum() / -loss["pnl"].sum() if len(loss) and loss["pnl"].sum() < 0 else np.nan,
            "1回あたり期待値(R)": tr["r"].mean(),
            "平均保有日数": tr["days"].mean(),
        })
    return out


def yearly(eq: pd.Series, tr: pd.DataFrame) -> pd.DataFrame:
    y = eq.groupby(eq.index.year).last()
    first = eq.iloc[0]
    ret = y / y.shift().fillna(first) - 1
    dd = eq.groupby(eq.index.year).apply(lambda s: (s / s.cummax() - 1).min())
    out = pd.DataFrame({"リターン": ret, "最大DD": dd})
    if len(tr):
        g = tr.groupby(tr["exit_date"].dt.year)
        out["取引数"] = g.size()
        out["勝率"] = g.apply(lambda t: (t["pnl"] > 0).mean())
    return out


def fmt(stats: dict) -> str:
    lines = []
    for k, v in stats.items():
        if isinstance(v, float):
            v = f"{v:.1%}" if any(s in k for s in ["リターン", "年率", "ドローダウン", "勝率", "(%)"]) else f"{v:.2f}"
        lines.append(f"  {k:<16} {v}")
    return "\n".join(lines)
