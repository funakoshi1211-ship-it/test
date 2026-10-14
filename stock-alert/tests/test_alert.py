from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from momentum_alert import main as m
from momentum_alert import news
from momentum_alert.signals import STAGE_EARLY, STAGE_LATE, evaluate

TH = m.load_config(m.ROOT / "config.yaml")["thresholds"]
IDX = pd.bdate_range("2025-01-01", periods=200)


def px(close, vol):
    return pd.DataFrame({"Close": close, "Volume": vol}, index=IDX)


def bench():
    return pd.Series(np.linspace(100, 104, len(IDX)), index=IDX)


def wiggle(n, seed=0):
    return 1 + np.random.default_rng(seed).normal(0, 0.006, n)


def breakout_stock():
    """横ばいの後、出来高を伴って高値を少し上抜けた（まだ上がり始め）"""
    c = np.r_[100 * wiggle(190), np.linspace(101, 109, 10)]
    v = np.r_[np.full(190, 1e6), np.full(10, 2.5e6)]
    return px(c, v)


def parabolic_stock():
    """すでに急騰済み"""
    c = np.r_[100 * wiggle(170), 100 * np.cumprod(np.full(30, 1.025))]
    v = np.r_[np.full(170, 1e6), np.full(30, 3e6)]
    return px(c, v)


def test_breakout_is_early():
    last = evaluate(breakout_stock(), bench(), TH).iloc[-1]
    assert bool(last["breakout"])
    assert last["score"] >= TH["alert_score"]
    assert last["stage"] == STAGE_EARLY


def test_parabolic_is_late():
    assert evaluate(parabolic_stock(), bench(), TH).iloc[-1]["stage"] == STAGE_LATE


def test_flat_stock_no_signal():
    last = evaluate(px(100 * wiggle(200, 3), np.full(200, 1e6)), bench(), TH).iloc[-1]
    assert last["stage"] == ""


def test_theme_triggers_when_many_members_move():
    prices = {"SPY": px(bench().values, np.full(200, 1e8))}
    for i, t in enumerate(["AAA", "BBB", "CCC", "DDD"]):
        prices[t] = breakout_stock() if i < 3 else px(100 * wiggle(200, i), np.full(200, 1e6))
    cfg = {"thresholds": TH, "benchmarks": {"us": "SPY"},
           "themes": {"テスト": {"tickers": ["AAA", "BBB", "CCC", "DDD"]}}}
    stocks, themes = m.analyze(cfg, prices)
    assert themes[0]["triggered"] and themes[0]["stage"] == STAGE_EARLY
    assert {s["ticker"] for s in stocks} == {"AAA", "BBB", "CCC"}


def test_is_new_dedupes_and_upgrades():
    st = {"alerts": {"stock:X": {"stage": STAGE_EARLY, "date": "2026-10-10"}}}
    assert not m.is_new(st, "stock:X", STAGE_EARLY, date(2026, 10, 14), 10)
    assert m.is_new(st, "stock:X", STAGE_LATE, date(2026, 10, 14), 10)
    assert m.is_new(st, "stock:X", STAGE_EARLY, date(2026, 10, 21), 10)
    assert m.is_new(st, "stock:Y", STAGE_EARLY, date(2026, 10, 14), 10)


RSS = b"""<?xml version="1.0"?><rss><channel>
<item><title>A</title><link>http://a</link><source>Nikkei</source><pubDate>Wed, 14 Oct 2026 01:00:00 GMT</pubDate></item>
<item><title>B</title><link>http://b</link><pubDate>Tue, 13 Oct 2026 20:00:00 GMT</pubDate></item>
<item><title>C</title><link>http://c</link><pubDate>Fri, 09 Oct 2026 20:00:00 GMT</pubDate></item>
</channel></rss>"""


def test_news_parse_and_buzz():
    items = news.parse(RSS)
    assert [i["title"] for i in items] == ["A", "B", "C"] and items[0]["source"] == "Nikkei"
    now = datetime(2026, 10, 14, 6, tzinfo=timezone.utc)
    th = {**TH, "news_min_count": 2}
    buzz = news.theme_buzz(["q1", "q2"], [0, 1, 0], th, now=now, fetcher=lambda q: items)
    assert buzz["count24h"] == 2  # 同じ見出しは重複して数えない
    assert buzz["surge"]
    calm = news.theme_buzz(["q"], [3, 3, 3], th, now=now, fetcher=lambda q: items)
    assert not calm["surge"]


def test_news_failure_does_not_raise():
    def boom(q):
        raise OSError("network")
    assert news.theme_buzz(["q"], [], TH, fetcher=boom)["count24h"] == 0


def test_report_marks_new_only_once():
    prices = {"SPY": px(bench().values, np.full(200, 1e8)), "AAA": breakout_stock()}
    cfg = {"thresholds": TH, "benchmarks": {"us": "SPY"}, "themes": {"t": {"tickers": ["AAA"]}}}
    stocks, themes = m.analyze(cfg, prices)
    state = {"alerts": {}}
    r1, n1 = m.build_report(stocks, themes, state, date(2026, 10, 14), 10)
    r2, n2 = m.build_report(stocks, themes, state, date(2026, 10, 15), 10)
    assert n1 == 1 and "🆕" in r1 and "AAA" in r1
    assert n2 == 0 and "🆕" not in r2
