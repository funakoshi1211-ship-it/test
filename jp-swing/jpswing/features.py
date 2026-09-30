"""銘柄・市場の特徴量。すべて「その日の終値時点で分かっていた情報」だけで計算する。"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import Config


def wide(prices: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """縦持ちの株価を 日付×銘柄 の表に変換する。"""
    return {c: prices.pivot(index="date", columns="code", values=c).sort_index()
            for c in ["open", "high", "low", "close", "volume", "turnover"]}


def rsi(close: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


def atr(high, low, close, n: int = 14) -> pd.DataFrame:
    pc = close.shift()
    tr = np.maximum(high - low, np.maximum((high - pc).abs(), (low - pc).abs()))
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def technical(w: dict[str, pd.DataFrame], topix: pd.Series, cfg: Config) -> dict[str, pd.DataFrame]:
    c, v = w["close"], w["volume"]
    tx = topix.reindex(c.index).ffill()
    f = {
        "close": c,
        "sma20": c.rolling(20, min_periods=20).mean(),
        "sma50": c.rolling(50, min_periods=50).mean(),
        "sma200": c.rolling(200, min_periods=200).mean(),
        "atr": atr(w["high"], w["low"], c),
        "rsi": rsi(c),
        "high252": c.rolling(252, min_periods=120).max(),
        "turnover20": w["turnover"].rolling(20, min_periods=15).mean(),
    }
    f["sma200_up"] = f["sma200"] > f["sma200"].shift(20)
    # 相対力：6か月（直近1か月を除く）の対TOPIX超過リターン。短期の反転を避けるため直近を除く
    r_stock = c.shift(21) / c.shift(126) - 1
    r_tx = tx.shift(21) / tx.shift(126) - 1
    f["rs"] = r_stock.sub(r_tx, axis=0)
    # 買い集め（機関投資家の継続的な買いの代理指標）：上昇日の出来高 ÷ 下落日の出来高（50日）
    up = c.diff() > 0
    upv = v.where(up, 0).rolling(50, min_periods=40).sum()
    dnv = v.where(~up, 0).rolling(50, min_periods=40).sum()
    f["accum"] = upv / dnv.replace(0, np.nan)
    return f


def regime(topix: pd.DataFrame, flows: pd.DataFrame | None, cfg: Config) -> pd.DataFrame:
    """市場環境。exposure = 新規買いに使ってよい保有枠の割合（0, 0.5, 1）。"""
    t = topix.set_index("date")["close"].sort_index()
    fast, slow = t.rolling(cfg.regime_fast).mean(), t.rolling(cfg.regime_slow).mean()
    strong = (t > slow) & (fast > slow)
    weak = t > slow
    exp = pd.Series(np.where(strong, 1.0, np.where(weak, 0.5, 0.0)), index=t.index)
    out = pd.DataFrame({"topix": t, "exposure": exp})
    if flows is not None and not flows.empty:
        fl = flows.set_index("date")["foreign_net"].sort_index().rolling(cfg.foreign_flow_weeks).sum()
        fl = fl.reindex(t.index, method="ffill")
        out["foreign_net"] = fl
        # 海外投資家が売り越し中は一段階慎重に（強気相場なら半分、それ以外は新規買いなし）
        neg = fl < 0
        out.loc[neg, "exposure"] = np.where(strong[neg], 0.5, 0.0)
    return out


# ---------------------------------------------------------------- ファンダメンタル

_PERIOD_Q = {"1Q": 1, "2Q": 2, "3Q": 3, "FY": 4}


def statement_scores(st: pd.DataFrame) -> pd.DataFrame:
    """決算短信1件ごとに、その時点で分かる財務指標とスコア（0〜100）を計算する。

    評価項目（各1点、欠損は0.5点）:
      収益性   ROE（会社予想ベース）8%以上 / 12%以上
      成長     営業利益 前年同期比 増益 / +10%以上
      上方修正 通期営業利益予想が前回開示より上昇
      進捗     営業利益の進捗率が期間相応＋5pt以上
      健全性   自己資本比率30%以上
      現金     営業キャッシュフローがプラス
    """
    st = st[st["TypeOfCurrentPeriod"].isin(_PERIOD_Q.keys()) | st["TypeOfDocument"].str.contains("Forecast", na=False)]
    st = st.sort_values(["code", "disclosed"]).copy()
    q = st["TypeOfCurrentPeriod"].map(_PERIOD_Q)

    fwd_profit = st["ForecastProfit"].where(st["ForecastProfit"].notna(), st["Profit"] * 4 / q)
    st["roe"] = fwd_profit / st["Equity"]
    # 同じ会社・同じ四半期区分の1年前の開示と比較
    st["fy"] = pd.to_datetime(st["CurrentFiscalYearStartDate"], errors="coerce").dt.year
    key = st[["code", "TypeOfCurrentPeriod", "fy", "OperatingProfit"]].dropna(subset=["fy", "OperatingProfit"])
    key = key.drop_duplicates(["code", "TypeOfCurrentPeriod", "fy"], keep="last").rename(columns={"OperatingProfit": "op_prev"})
    key["fy"] += 1
    st = st.merge(key, on=["code", "TypeOfCurrentPeriod", "fy"], how="left")
    st["op_growth"] = (st["OperatingProfit"] - st["op_prev"]) / st["op_prev"].abs()
    # 予想の変化（同じ会社の直前の開示と比較）
    prev_fc = st.groupby("code")["ForecastOperatingProfit"].shift()
    st["revision"] = (st["ForecastOperatingProfit"] - prev_fc) / prev_fc.abs()
    # 本決算（FY）の予想は翌期のもので「修正」ではないので除外
    new_year = (st["TypeOfCurrentPeriod"] == "FY") & st["TypeOfDocument"].str.contains("FinancialStatements", na=False)
    st.loc[new_year, "revision"] = np.nan
    q = st["TypeOfCurrentPeriod"].map(_PERIOD_Q)
    st["progress_gap"] = st["OperatingProfit"] / st["ForecastOperatingProfit"] - q / 4
    eq_ratio = st["EquityToAssetRatio"]
    eq_ratio = eq_ratio.where(eq_ratio <= 1.5, eq_ratio / 100)  # %表記に対応

    def pts(cond, valid):
        return np.where(valid, cond.astype(float), 0.5)

    items = [
        pts(st["roe"] >= 0.08, st["roe"].notna()),
        pts(st["roe"] >= 0.12, st["roe"].notna()),
        pts(st["op_growth"] > 0, st["op_growth"].notna()),
        pts(st["op_growth"] >= 0.10, st["op_growth"].notna()),
        pts(st["revision"] > 0.01, st["revision"].notna()) * 1.5,  # 上方修正は重視（決算後ドリフト）
        pts((st["progress_gap"] >= 0.05) & (q < 4), st["progress_gap"].notna() & (q < 4)),
        pts(eq_ratio >= 0.30, eq_ratio.notna()),
        pts(st["CashFlowsFromOperatingActivities"] > 0, st["CashFlowsFromOperatingActivities"].notna()),
    ]
    st["fund_score"] = 100 * np.sum(items, axis=0) / 8.5
    # 赤字予想は対象外
    st.loc[st["ForecastProfit"] < 0, "fund_score"] = 0.0
    st["eps_fwd"] = st["ForecastEarningsPerShare"].where(st["ForecastEarningsPerShare"].notna(),
                                                         st["EarningsPerShare"] * 4 / q)
    # 予想のみの開示（業績修正）は、財務数値を前回の値で補う
    for c in ["roe", "fund_score", "eps_fwd"]:
        st[c] = st.groupby("code")[c].ffill()
    return st[["code", "disclosed", "fund_score", "roe", "op_growth", "revision", "eps_fwd"]]


def fundamentals_wide(scores: pd.DataFrame, index: pd.DatetimeIndex, columns) -> dict[str, pd.DataFrame]:
    """開示日の翌営業日から使えるものとして、日付×銘柄 の表に展開する（先読み防止）。"""
    s = scores.copy()
    # 開示は大半が15時以降なので、翌営業日から反映
    pos = index.searchsorted(s["disclosed"], side="right")
    s = s[pos < len(index)]
    s["avail"] = index[pos[pos < len(index)]]
    s = s.drop_duplicates(["code", "avail"], keep="last")
    out = {}
    for c in ["fund_score", "eps_fwd", "revision"]:
        out[c] = s.pivot(index="avail", columns="code", values=c).reindex(index=index, columns=columns).ffill()
    # 直近60営業日以内に上方修正があったか（決算後ドリフト狙い）
    rev = s[s["revision"] > 0.01].pivot(index="avail", columns="code", values="revision")
    out["recent_upgrade"] = rev.reindex(index=index, columns=columns).notna().rolling(60, min_periods=1).max().astype(bool)
    return out


def earnings_blackout(dates_by_code: pd.DataFrame, index: pd.DatetimeIndex, columns, days: int) -> pd.DataFrame:
    """決算発表の days 営業日前〜当日を True にする。発表日は事前に公表されるため先読みには当たらない。"""
    arr = np.zeros((len(index), len(columns)), dtype=bool)
    if dates_by_code is not None and not dates_by_code.empty:
        col = pd.Index(columns)
        d = dates_by_code[dates_by_code["code"].isin(col)]
        pos = index.searchsorted(d["date"])
        for p, j in zip(pos, col.get_indexer(d["code"])):
            if p < len(index):
                arr[max(0, p - days):p + 1, j] = True
    return pd.DataFrame(arr, index=index, columns=columns)
