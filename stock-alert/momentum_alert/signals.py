"""銘柄ごとの指標・点数・段階（初動／加速／過熱）と、テーマ単位の集計。

指標はすべて日次の時系列で計算する。最新日だけ見ればライブのアラート、
全期間を見ればバックテストに使える。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

STAGE_EARLY = "初動"
STAGE_MID = "加速"
STAGE_LATE = "過熱"
STAGE_NONE = ""


def _rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(100)


def indicators(px: pd.DataFrame, bench_close: pd.Series) -> pd.DataFrame:
    """px は Close / Volume 列を持つ日足。bench_close は比較対象の終値。"""
    close = px["Close"].astype(float)
    vol = px["Volume"].astype(float)
    bench = bench_close.reindex(close.index).ffill()

    out = pd.DataFrame(index=close.index)
    out["close"] = close
    for n in (5, 10, 20):
        r = close.pct_change(n) * 100
        out[f"ret{n}"] = r
        out[f"rs{n}"] = r - bench.pct_change(n) * 100  # 指数に対する超過リターン

    ma20 = close.rolling(20).mean()
    ma50 = close.rolling(50).mean()
    out["ext50"] = (close / ma50 - 1) * 100
    out["ma_aligned"] = (close > ma20) & (ma20 > ma50)
    out["ma20_up"] = ma20 > ma20.shift(5)

    # 直近5日の出来高 ÷ その前50日の出来高
    out["vol_ratio"] = vol.rolling(5).mean() / vol.shift(5).rolling(50).mean()
    # 前日までの55日高値を終値で上抜けたか
    out["breakout"] = close >= close.shift(1).rolling(55).max()
    # 上抜け前の値幅（10〜60日前）。狭いほど「溜め」があった
    win = close.shift(10).rolling(50)
    out["base_range"] = (win.max() / win.min() - 1) * 100
    out["rsi"] = _rsi(close)
    out["dollar_vol"] = (close * vol).rolling(20).mean()
    return out


def score(ind: pd.DataFrame) -> pd.Series:
    """0〜100点。「動き始め」の特徴が重なるほど高い。"""
    s = pd.Series(0.0, index=ind.index)
    # 指数より強い（10日超過リターン 0→8% で 0→25点）
    s += (ind["rs10"].clip(0, 8) / 8 * 25).fillna(0)
    # 出来高の増加（1.0→2.0倍 で 0→20点）
    s += ((ind["vol_ratio"] - 1).clip(0, 1) * 20).fillna(0)
    # 55日高値の上抜け
    s += ind["breakout"].astype(float) * 20
    # 移動平均の並び（終値 > 20日線 > 50日線 かつ 20日線が上向き）
    s += (ind["ma_aligned"] & ind["ma20_up"]).astype(float) * 15
    # 直近5日も強い（加速している）
    s += ((ind["rs5"] > 0) & (ind["rs5"] >= ind["rs10"] / 2)).astype(float) * 10
    # 上抜け前の値幅が狭い（35%→15% で 0→10点）
    s += ((35 - ind["base_range"]).clip(0, 20) / 20 * 10).fillna(0)
    return s.round(1)


def stage(ind: pd.DataFrame, sc: pd.Series, th: dict) -> pd.Series:
    # RSI は上がり始めでもすぐ高くなるので、初動の範囲を超えて上がっているときだけ過熱の材料にする
    overbought = (ind["rsi"] > th["late_rsi"]) & (ind["ret20"] > th["early_max_ret20"])
    late = (ind["ret20"] > th["late_ret20"]) | (ind["ext50"] > th["late_ext50"]) | overbought
    hot = sc >= th["alert_score"]
    early = hot & (ind["ret20"] <= th["early_max_ret20"]) & (ind["ext50"] <= th["early_max_ext50"])
    out = pd.Series(STAGE_NONE, index=ind.index, dtype=object)
    out[hot] = STAGE_MID
    out[early] = STAGE_EARLY
    out[late & hot] = STAGE_LATE
    return out


def evaluate(px: pd.DataFrame, bench_close: pd.Series, th: dict) -> pd.DataFrame:
    ind = indicators(px, bench_close)
    ind["score"] = score(ind)
    ind["stage"] = stage(ind, ind["score"], th)
    return ind


def theme_summary(name: str, latest: dict[str, pd.Series], etf_latest: dict[str, pd.Series], th: dict) -> dict | None:
    """テーマ内の最新値（銘柄→最新行）から、テーマ全体が動き始めているかを判定する。"""
    if len(latest) < 3:
        return None
    df = pd.DataFrame(latest).T
    breadth = float((df["score"] >= th["watch_score"]).mean())
    med_rs10 = float(df["rs10"].median())
    med_rs5 = float(df["rs5"].median())
    med_ret20 = float(df["ret20"].median())
    etf_break = [t for t, r in etf_latest.items() if bool(r["breakout"])]
    triggered = breadth >= th["theme_breadth"] and med_rs10 >= th["theme_min_rs10"]
    if med_ret20 > th["late_ret20"]:
        stg = STAGE_LATE
    elif med_ret20 <= th["early_max_ret20"]:
        stg = STAGE_EARLY
    else:
        stg = STAGE_MID
    leaders = df.sort_values("score", ascending=False).head(5)
    return {
        "theme": name,
        "triggered": triggered,
        "stage": stg if triggered else STAGE_NONE,
        "breadth": breadth,
        "n": len(df),
        "med_rs5": med_rs5,
        "med_rs10": med_rs10,
        "med_ret20": med_ret20,
        "etf_breakouts": etf_break,
        "leaders": [(t, float(r["score"]), str(r["stage"])) for t, r in leaders.iterrows()],
    }
