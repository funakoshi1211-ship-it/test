"""動作確認用の架空データ。戦略の有効性の検証には使えない（実データで行うこと）。"""
from __future__ import annotations

import numpy as np
import pandas as pd


def make(n_codes: int = 120, start: str = "2016-01-04", end: str = "2025-12-30", seed: int = 0) -> dict:
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(start, end)
    T = len(dates)
    mkt = np.cumsum(rng.normal(0.0003, 0.011, T))
    topix = 1500 * np.exp(mkt)
    codes = [str(1300 + i * 7) for i in range(n_codes)]
    quality = rng.normal(0, 1, n_codes)
    sectors = [f"業種{i % 11}" for i in range(n_codes)]
    rows, st_rows = [], []
    for k, code in enumerate(codes):
        beta = rng.uniform(0.6, 1.4)
        drift = 0.00025 * quality[k]
        idio = np.cumsum(rng.normal(drift, 0.018, T))
        logp = np.log(rng.uniform(500, 5000)) + beta * mkt + idio
        close = np.exp(logp)
        open_ = close * np.exp(rng.normal(0, 0.006, T))
        high = np.maximum(open_, close) * np.exp(np.abs(rng.normal(0, 0.008, T)))
        low = np.minimum(open_, close) * np.exp(-np.abs(rng.normal(0, 0.008, T)))
        vol = rng.lognormal(12 + quality[k] * 0.3, 0.4, T)
        rows.append(pd.DataFrame({"date": dates, "code": code, "open": open_, "high": high, "low": low,
                                  "close": close, "volume": vol, "turnover": close * vol}))
        # 四半期ごとの決算
        base = rng.uniform(5e9, 5e10)
        for y in range(dates[0].year, dates[-1].year + 1):
            growth = (1 + 0.08 * quality[k]) ** (y - dates[0].year)
            fc = base * growth * rng.uniform(0.9, 1.1)
            for qi, (per, month) in enumerate([("FY", 5), ("1Q", 8), ("2Q", 11), ("3Q", 2)]):
                year = y if month != 2 else y + 1
                d = pd.Timestamp(year, month, 10 + k % 15)
                qn = {"FY": 4, "1Q": 1, "2Q": 2, "3Q": 3}[per]
                op = fc * qn / 4 * rng.uniform(0.85, 1.2) * (1 + 0.1 * quality[k])
                st_rows.append({
                    "LocalCode": code + "0", "DisclosedDate": d.strftime("%Y-%m-%d"),
                    "TypeOfDocument": f"{per}FinancialStatements_Consolidated_JP", "TypeOfCurrentPeriod": per,
                    "CurrentFiscalYearStartDate": f"{year - (1 if per == 'FY' else 0)}-04-01",
                    "OperatingProfit": op, "Profit": op * 0.7, "Equity": base * 8,
                    "EquityToAssetRatio": rng.uniform(0.2, 0.7),
                    "CashFlowsFromOperatingActivities": op * rng.uniform(-0.2, 1.2),
                    "ForecastOperatingProfit": fc, "ForecastProfit": fc * 0.7,
                    "ForecastEarningsPerShare": fc * 0.7 / 1e8, "EarningsPerShare": op * 0.7 / 1e8,
                })
    from .data import normalize_statements
    st = pd.DataFrame(st_rows)
    st = st[pd.to_datetime(st["DisclosedDate"]) <= dates[-1]]
    weeks = dates[dates.weekday == 3]
    return {
        "prices": pd.concat(rows, ignore_index=True),
        "listed": pd.DataFrame({"code": codes, "name": [f"架空{c}" for c in codes],
                                "sector33": sectors, "market": "プライム"}),
        "statements": normalize_statements(st),
        "topix": pd.DataFrame({"date": dates, "close": topix}),
        "flows": pd.DataFrame({"date": weeks, "foreign_net": rng.normal(2e10, 1.5e11, len(weeks))}),
        "announce": None,
    }
