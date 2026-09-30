import numpy as np
import pandas as pd
import pytest

from jpswing import backtest, features as F, orders, strategy, synthetic
from jpswing.config import Config


@pytest.fixture(scope="module")
def model():
    return strategy.build(synthetic.make(n_codes=60, start="2018-01-04", end="2023-12-29"), Config())


def test_fundamentals_not_visible_on_disclosure_day():
    idx = pd.bdate_range("2024-05-01", "2024-05-31")
    s = pd.DataFrame({"code": ["1301"], "disclosed": [pd.Timestamp("2024-05-10")], "fund_score": [80.0],
                      "eps_fwd": [100.0], "revision": [0.05]})
    w = F.fundamentals_wide(s, idx, ["1301"])
    assert np.isnan(w["fund_score"].loc["2024-05-10", "1301"])
    assert w["fund_score"].loc["2024-05-13", "1301"] == 80.0


def test_earnings_blackout_window():
    idx = pd.bdate_range("2024-05-01", "2024-05-31")
    b = F.earnings_blackout(pd.DataFrame({"code": ["1301"], "date": [pd.Timestamp("2024-05-20")]}), idx, ["1301"], 3)
    on = b.index[b["1301"]]
    assert list(on) == list(pd.bdate_range("2024-05-15", "2024-05-20"))


def test_position_size_respects_risk_and_caps():
    cfg = Config()
    n = strategy.shares_for(10_000_000, 10_000_000, 1000, 20, cfg)
    assert n % 100 == 0
    assert n * cfg.stop_atr * 20 <= 10_000_000 * cfg.risk_per_trade
    assert n * 1000 <= 10_000_000 * cfg.max_position_weight
    assert strategy.shares_for(1_000_000, 50_000, 1000, 20, cfg) == 0  # 資金不足


def test_tick_rounding():
    assert strategy.round_down(2999.7) == 2999
    assert strategy.round_down(4123) == 4120
    assert strategy.round_down(12345) == 12340


def test_stop_only_moves_up():
    cfg = Config()
    p = backtest.Position("1301", pd.Timestamp("2024-01-04"), 1000, 100, 960, 40, 1100)
    stop, reason = backtest.update_stop(p, 1090, 20, 1000, cfg)
    assert stop == max(1100 - 3 * 20, 1000)  # 1R 以上の含み益 → 少なくとも買値
    p.stop = 1050
    stop, _ = backtest.update_stop(p, 1090, 40, 1000, cfg)
    assert stop == 1050
    _, reason = backtest.update_stop(p, 990, 20, 1000, cfg)
    assert reason and "線割れ" in reason


def test_backtest_accounting(model):
    res = backtest.run(model, capital=3_000_000)
    assert res.equity.notna().all() and (res.equity > 0).all()
    tr = res.trades
    assert len(tr) > 0
    # 最終資産 = 初期資金 + 全取引の損益（期末建玉も決済済み）
    assert res.equity.iloc[-1] == pytest.approx(3_000_000 + tr["pnl"].sum(), rel=1e-3)
    assert (tr["shares"] % 100 == 0).all()
    # 同時保有数の上限
    events = pd.concat([pd.Series(1, tr["entry_date"]), pd.Series(-1, tr["exit_date"])]).sort_index()
    assert events.groupby(level=0).sum().cumsum().max() <= Config().max_positions


def test_entry_signals_meet_rules(model):
    f, cfg = model.f, model.cfg
    ent = model.entry.stack()
    ent = ent[ent]
    for d, c in list(ent.index)[:200]:
        assert f["close"].loc[d, c] > f["sma50"].loc[d, c] > f["sma200"].loc[d, c]
        assert cfg.rsi_low <= f["rsi"].loc[d, c] <= cfg.rsi_high
        assert model.fund["fund_score"].loc[d, c] >= cfg.min_fund_score


def test_orders_sheet(model, tmp_path):
    date = model.w["close"].index[-1]
    code = model.w["close"].columns[0]
    c = model.f["close"].loc[date, code]
    pos = [backtest.Position(code, date - pd.Timedelta(days=30), c * 0.9, 100, c * 0.8, c * 0.05, c)]
    o = orders.make(model, pos, 3_000_000, 1_000_000, date)
    md = orders.to_markdown(o)
    assert "発注指示書" in md and code in md
    orders.save_positions(pos, tmp_path / "p.csv")
    back = orders.load_positions(tmp_path / "p.csv")
    assert back[0].code == code and back[0].stop >= c * 0.8 - 1
