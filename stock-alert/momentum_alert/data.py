"""株価の取得（Yahoo Finance）。"""
from __future__ import annotations

import pandas as pd


def is_jp(ticker: str) -> bool:
    return ticker.endswith(".T")


def download(tickers: list[str], period: str = "1y") -> dict[str, pd.DataFrame]:
    """銘柄→日足（Close, Volume）。取れなかった銘柄は入れない。"""
    import yfinance as yf

    raw = yf.download(sorted(set(tickers)), period=period, interval="1d", auto_adjust=True,
                      group_by="ticker", progress=False, threads=True)
    out = {}
    for t in set(tickers):
        try:
            df = raw[t][["Close", "Volume"]].dropna()
        except KeyError:
            continue
        if len(df) >= 80:
            out[t] = df
        else:
            print(f"[data] {t}: データ不足（{len(df)}日）")
    return out
