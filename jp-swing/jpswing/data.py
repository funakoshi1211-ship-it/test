"""データの取得と保存。

主なデータ源は J-Quants API（JPX公式）。日付ごとに全銘柄の株価を取るため、
上場廃止銘柄も含まれ、生存者バイアスのない検証ができる。

保存形式（data/ 配下、pandas pickle）:
  prices.pkl      : date, code, open, high, low, close, volume, turnover （分割調整済み）
  listed.pkl      : code, name, sector33, market
  statements.pkl  : 決算短信（J-Quants fins/statements の列をそのまま、数値化済み）
  topix.pkl       : date, close
  flows.pkl       : date, foreign_net （投資部門別：海外投資家の現物差引、週次）
  announce.pkl    : date, code （今後の決算発表予定）

J-Quants 以外のデータ源を使う場合も、この形式の pickle を置けば他の処理はそのまま動く。
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import pandas as pd
import requests

DATA_DIR = Path(os.environ.get("JPSWING_DATA", "data"))
API = "https://api.jquants.com/v1"

NUMERIC_STATEMENT_COLS = [
    "NetSales", "OperatingProfit", "OrdinaryProfit", "Profit", "EarningsPerShare",
    "TotalAssets", "Equity", "EquityToAssetRatio", "BookValuePerShare",
    "CashFlowsFromOperatingActivities",
    "ForecastNetSales", "ForecastOperatingProfit", "ForecastProfit", "ForecastEarningsPerShare",
    "NextYearForecastOperatingProfit", "NextYearForecastEarningsPerShare",
]


def path(name: str) -> Path:
    return DATA_DIR / f"{name}.pkl"


def load(name: str) -> pd.DataFrame | None:
    p = path(name)
    return pd.read_pickle(p) if p.exists() else None


def save(name: str, df: pd.DataFrame) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    df.to_pickle(path(name))


class JQuants:
    """J-Quants API v1 の最小クライアント。

    認証情報は環境変数 JQUANTS_REFRESH_TOKEN、または JQUANTS_EMAIL / JQUANTS_PASSWORD。
    無料プランはデータが12週間遅れのため、実際の発注判断には有料プラン（Light 以上）が必要。
    """

    def __init__(self):
        self.s = requests.Session()
        self.id_token = self._id_token()

    def _id_token(self) -> str:
        refresh = os.environ.get("JQUANTS_REFRESH_TOKEN")
        if not refresh:
            email, pw = os.environ.get("JQUANTS_EMAIL"), os.environ.get("JQUANTS_PASSWORD")
            if not (email and pw):
                raise SystemExit("J-Quants の認証情報がありません。README の「準備」を参照してください。")
            r = self.s.post(f"{API}/token/auth_user", json={"mailaddress": email, "password": pw}, timeout=30)
            r.raise_for_status()
            refresh = r.json()["refreshToken"]
        r = self.s.post(f"{API}/token/auth_refresh", params={"refreshtoken": refresh}, timeout=30)
        r.raise_for_status()
        return r.json()["idToken"]

    def get(self, endpoint: str, key: str, **params) -> list[dict]:
        rows, headers = [], {"Authorization": f"Bearer {self.id_token}"}
        while True:
            for attempt in range(4):
                r = self.s.get(f"{API}/{endpoint}", params=params, headers=headers, timeout=60)
                if r.status_code == 429 or r.status_code >= 500:
                    time.sleep(2 ** attempt)
                    continue
                break
            r.raise_for_status()
            body = r.json()
            rows += body.get(key, [])
            if "pagination_key" not in body:
                return rows
            params["pagination_key"] = body["pagination_key"]


def _code(s: pd.Series) -> pd.Series:
    # J-Quants のコードは 5桁（末尾0）。4桁に揃える
    s = s.astype(str)
    return s.where(~((s.str.len() == 5) & s.str.endswith("0")), s.str[:4])


def fetch_all(start: str, end: str | None = None) -> None:
    jq = JQuants()
    end = end or pd.Timestamp.today().strftime("%Y-%m-%d")

    # 銘柄一覧
    info = pd.DataFrame(jq.get("listed/info", "info"))
    listed = pd.DataFrame({
        "code": _code(info["Code"]), "name": info["CompanyName"],
        "sector33": info["Sector33CodeName"], "market": info["MarketCodeName"],
    }).drop_duplicates("code")
    save("listed", listed)
    print(f"銘柄一覧: {len(listed)}件")

    # 株価（日付ごと。既存分は差分だけ取る）
    old = load("prices")
    have = set(old["date"].dt.strftime("%Y-%m-%d")) if old is not None else set()
    days = pd.bdate_range(start, end)
    frames = [old] if old is not None else []
    for i, d in enumerate(days):
        ds = d.strftime("%Y-%m-%d")
        if ds in have:
            continue
        q = pd.DataFrame(jq.get("prices/daily_quotes", "daily_quotes", date=ds))
        if q.empty:
            continue
        frames.append(pd.DataFrame({
            "date": pd.to_datetime(q["Date"]), "code": _code(q["Code"]),
            "open": q["AdjustmentOpen"], "high": q["AdjustmentHigh"], "low": q["AdjustmentLow"],
            "close": q["AdjustmentClose"], "volume": q["AdjustmentVolume"], "turnover": q["TurnoverValue"],
        }).dropna(subset=["close"]))
        if i % 50 == 0:
            print(f"株価 {ds} まで取得")
    prices = pd.concat(frames).drop_duplicates(["date", "code"], keep="last").sort_values(["date", "code"])
    save("prices", prices.reset_index(drop=True))
    print(f"株価: {prices['date'].min():%Y-%m-%d}〜{prices['date'].max():%Y-%m-%d}")

    # 決算短信（日付ごと）
    st_frames = []
    for d in pd.bdate_range(start, end):
        rows = jq.get("fins/statements", "statements", date=d.strftime("%Y-%m-%d"))
        if rows:
            st_frames.append(pd.DataFrame(rows))
    st = pd.concat(st_frames, ignore_index=True)
    save("statements", normalize_statements(st))
    print(f"決算短信: {len(st)}件")

    # TOPIX
    tx = pd.DataFrame(jq.get("indices/topix", "topix", **{"from": start, "to": end}))
    save("topix", pd.DataFrame({"date": pd.to_datetime(tx["Date"]), "close": tx["Close"].astype(float)}))

    # 投資部門別売買状況（プライム市場、海外投資家の差引）
    ts = pd.DataFrame(jq.get("markets/trades_spec", "trades_spec", section="TSEPrime", **{"from": start, "to": end}))
    if not ts.empty:
        save("flows", pd.DataFrame({
            "date": pd.to_datetime(ts["PublishedDate"]), "foreign_net": ts["ForeignersBalance"].astype(float),
        }).sort_values("date"))

    # 決算発表予定（翌営業日以降の分のみ提供される）
    an = pd.DataFrame(jq.get("fins/announcement", "announcement"))
    if not an.empty:
        save("announce", pd.DataFrame({"date": pd.to_datetime(an["Date"]), "code": _code(an["Code"])}))
    print("完了")


def normalize_statements(st: pd.DataFrame) -> pd.DataFrame:
    st = st.copy()
    st["code"] = _code(st["LocalCode"])
    st["disclosed"] = pd.to_datetime(st["DisclosedDate"])
    for c in NUMERIC_STATEMENT_COLS:
        if c in st.columns:
            st[c] = pd.to_numeric(st[c].replace("", None), errors="coerce")
        else:
            st[c] = float("nan")
    for c in ["TypeOfDocument", "TypeOfCurrentPeriod", "CurrentFiscalYearStartDate"]:
        if c not in st.columns:
            st[c] = None
    return st.sort_values(["code", "disclosed"]).reset_index(drop=True)


def fetch_yfinance(codes: list[str], start: str) -> None:
    """J-Quants を使わない場合の株価取得（検証の精度は下がる：上場廃止銘柄が含まれない）。"""
    import yfinance as yf  # 任意の依存

    frames = []
    for c in codes:
        h = yf.Ticker(f"{c}.T").history(start=start, auto_adjust=True)
        if h.empty:
            continue
        frames.append(pd.DataFrame({
            "date": h.index.tz_localize(None).normalize(), "code": c,
            "open": h["Open"].values, "high": h["High"].values, "low": h["Low"].values,
            "close": h["Close"].values, "volume": h["Volume"].values,
            "turnover": (h["Close"] * h["Volume"]).values,
        }))
    save("prices", pd.concat(frames, ignore_index=True))
    tx = yf.Ticker("1306.T").history(start=start, auto_adjust=True)  # TOPIX連動ETFで代用
    save("topix", pd.DataFrame({"date": tx.index.tz_localize(None).normalize(), "close": tx["Close"].values}))


def load_all() -> dict:
    d = {k: load(k) for k in ["prices", "listed", "statements", "topix", "flows", "announce"]}
    if d["prices"] is None or d["topix"] is None:
        raise SystemExit("data/ に prices と topix がありません。先に fetch を実行してください。")
    return d
