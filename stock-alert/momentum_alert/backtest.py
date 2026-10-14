"""過去データで「初動」シグナルがその後どうなったかを確かめる。

  python -m momentum_alert.backtest            # 過去3年
  python -m momentum_alert.backtest --period 5y

見るもの：
  - シグナル後10日・20日の、指数に対する超過リターン（平均・中央値・プラスだった割合）
  - シグナル後30日以内に20日上昇率が「過熱」水準に達した割合（＝急騰をとらえられたか）
  - 比較用に、シグナルに関係なく全営業日で同じ数字
"""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from . import data
from .main import ROOT, load_config
from .signals import STAGE_EARLY, evaluate


def events(ind: pd.DataFrame, bench: pd.Series, th: dict, gap: int = 10) -> pd.DataFrame:
    close = ind["close"]
    b = bench.reindex(close.index).ffill()
    fwd = pd.DataFrame(index=close.index)
    for n in (10, 20):
        fwd[f"ex{n}"] = (close.shift(-n) / close - (b.shift(-n) / b)) * 100
    # 30日先までに20日上昇率が過熱水準に達したか
    fwd["hit"] = (ind["ret20"][::-1].rolling(30, min_periods=1).max()[::-1].shift(-1) > th["late_ret20"]).astype(float)

    sig = ind["stage"] == STAGE_EARLY
    first = sig & ~sig.shift(1).rolling(gap, min_periods=1).max().fillna(0).astype(bool)
    return fwd.assign(signal=first).dropna(subset=["ex20"])


def summarize(df: pd.DataFrame) -> dict:
    return {
        "件数": len(df),
        "10日超過 平均%": round(df["ex10"].mean(), 2),
        "20日超過 平均%": round(df["ex20"].mean(), 2),
        "20日超過 中央値%": round(df["ex20"].median(), 2),
        "20日 プラス率": f"{(df['ex20'] > 0).mean():.0%}",
        "30日内 急騰到達率": f"{df['hit'].astype(float).mean():.0%}",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--period", default="3y")
    args = ap.parse_args()
    cfg = load_config(Path(args.config))
    th = cfg["thresholds"]

    tickers = list(cfg["benchmarks"].values())
    for spec in cfg["themes"].values():
        tickers += spec.get("tickers", [])
    prices = data.download(tickers, period=args.period)
    bench = {k: prices[t]["Close"] for k, t in cfg["benchmarks"].items() if t in prices}

    frames = []
    for t, px in prices.items():
        if t in cfg["benchmarks"].values():
            continue
        b = bench.get("jp" if data.is_jp(t) else "us")
        if b is None:
            continue
        frames.append(events(evaluate(px, b, th), b, th).assign(ticker=t))
    allev = pd.concat(frames)
    rows = {"初動シグナル": summarize(allev[allev["signal"]]), "全営業日(比較)": summarize(allev)}
    print(pd.DataFrame(rows).to_string())


if __name__ == "__main__":
    main()
