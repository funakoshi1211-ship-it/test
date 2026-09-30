"""銘柄選定のルール。

考え方：「業績が良く（ファンダメンタル）、市場全体より強く（相対力）、
資金が継続的に入っている（買い集め）銘柄が、上昇トレンドの中で一時的に押したところを買う」。
高値追いより押し目買いの方が勝率は高く、損切り幅も狭くできる。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import features as F
from .config import Config


@dataclass
class Model:
    cfg: Config
    w: dict            # 株価（日付×銘柄）
    f: dict            # テクニカル特徴量
    fund: dict         # ファンダメンタル（日付×銘柄）
    reg: pd.DataFrame  # 市場環境
    universe: pd.DataFrame
    entry: pd.DataFrame
    score: pd.DataFrame
    sector: pd.Series
    names: pd.Series


def _rank(df: pd.DataFrame, mask: pd.DataFrame) -> pd.DataFrame:
    return df.where(mask).rank(axis=1, pct=True)


def build(data: dict, cfg: Config) -> Model:
    w = F.wide(data["prices"])
    idx, cols = w["close"].index, w["close"].columns
    topix = data["topix"].set_index("date")["close"].sort_index()
    f = F.technical(w, topix, cfg)
    reg = F.regime(data["topix"], data.get("flows"), cfg).reindex(idx).ffill()

    listed = data.get("listed")
    if listed is not None:
        listed = listed.set_index("code")
        sector = listed["sector33"].reindex(cols).fillna("不明")
        names = listed["name"].reindex(cols).fillna("")
        mk = listed["market"].reindex(cols).fillna("")
        market_ok = pd.Series([any(m in x for m in cfg.markets) for x in mk], index=cols)
    else:
        sector = pd.Series("不明", index=cols)
        names = pd.Series("", index=cols)
        market_ok = pd.Series(True, index=cols)

    st = data.get("statements")
    if st is not None and not st.empty:
        fund = F.fundamentals_wide(F.statement_scores(st), idx, cols)
        per = f["close"] / fund["eps_fwd"]
        fund_ok = (fund["fund_score"] >= cfg.min_fund_score) & (per > 0) & (per <= cfg.max_per)
        # 決算発表日：過去は実際の開示日、将来は発表予定
        ann = st[["code", "disclosed"]].rename(columns={"disclosed": "date"})
        if data.get("announce") is not None:
            ann = pd.concat([ann, data["announce"]])
        blackout = F.earnings_blackout(ann, idx, cols, cfg.earnings_blackout_days)
    else:  # 財務データなし（yfinance 等）。ファンダメンタル条件は使わない
        fund = {"fund_score": pd.DataFrame(50.0, index=idx, columns=cols),
                "recent_upgrade": pd.DataFrame(False, index=idx, columns=cols)}
        fund_ok = pd.DataFrame(True, index=idx, columns=cols)
        blackout = pd.DataFrame(False, index=idx, columns=cols)

    c = f["close"]
    universe = (c >= cfg.min_price) & (f["turnover20"] >= cfg.min_turnover) & market_ok.values[None, :]
    trend = (c > f["sma50"]) & (f["sma50"] > f["sma200"]) & f["sma200_up"] & (c >= f["high252"] * (1 - cfg.near_high_pct))
    pullback = (f["rsi"] >= cfg.rsi_low) & (f["rsi"] <= cfg.rsi_high) & (c < c.shift(5))
    strength = (f["rs"] > cfg.min_rs_126) & (f["accum"] > 1.0)
    entry = universe & trend & pullback & strength & fund_ok & ~blackout

    score = (cfg.w_momentum * _rank(f["rs"], universe)
             + cfg.w_fundamental * fund["fund_score"] / 100
             + cfg.w_accumulation * _rank(f["accum"], universe)
             + 0.05 * fund["recent_upgrade"].astype(float))
    return Model(cfg, w, f, fund, reg, universe, entry.fillna(False), score.where(entry), sector, names)


def candidates(m: Model, date) -> pd.DataFrame:
    """その日の終値で条件を満たした銘柄をスコア順に返す。"""
    s = m.score.loc[date].dropna().sort_values(ascending=False)
    f = m.f
    return pd.DataFrame({
        "code": s.index, "name": m.names.reindex(s.index).values, "sector": m.sector.reindex(s.index).values,
        "score": s.values.round(3),
        "close": f["close"].loc[date, s.index].values, "atr": f["atr"].loc[date, s.index].values,
        "rs": f["rs"].loc[date, s.index].values.round(3), "rsi": f["rsi"].loc[date, s.index].values.round(1),
        "fund_score": m.fund["fund_score"].loc[date, s.index].values.round(0),
    })


def tick(price: float) -> float:
    """東証の呼値（通常銘柄の表）。"""
    for limit, t in [(3000, 1), (5000, 5), (30000, 10), (50000, 50), (300000, 100), (500000, 500), (3e6, 1000)]:
        if price <= limit:
            return t
    return 5000


def round_down(price: float) -> float:
    t = tick(price)
    return float(np.floor(price / t) * t)


def shares_for(equity: float, cash: float, price: float, atr: float, cfg: Config) -> int:
    """損切りに掛かった時の損失が資金の risk_per_trade になる株数（単元未満切り捨て）。"""
    risk_per_share = cfg.stop_atr * atr
    if not (risk_per_share > 0 and price > 0):
        return 0
    n = equity * cfg.risk_per_trade / risk_per_share
    n = min(n, equity * cfg.max_position_weight / price, cash / (price * (1 + cfg.cost_per_side)))
    return int(n // cfg.lot_size * cfg.lot_size)
