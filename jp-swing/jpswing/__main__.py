"""使い方:
  python -m jpswing fetch --start 2016-01-01          J-Quants からデータ取得（2回目以降は差分）
  python -m jpswing backtest --start 2018-01-01        過去検証
  python -m jpswing orders --equity 3000000 --cash 1500000 [--positions positions.csv]
  python -m jpswing demo                               架空データで動作確認
"""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from . import backtest, data, orders, strategy, synthetic
from .config import Config

OUT = Path("output")


def _backtest(d: dict, args) -> None:
    cfg = Config()
    m = strategy.build(d, cfg)
    res = backtest.run(m, args.start, args.end, args.capital)
    print("\n=== 検証結果 ===")
    print(backtest.fmt(res.stats))
    print("\n=== 年別 ===")
    y = res.yearly.copy()
    for c in ["リターン", "最大DD", "勝率"]:
        if c in y:
            y[c] = y[c].map(lambda x: f"{x:.1%}" if pd.notna(x) else "-")
    if "取引数" in y:
        y["取引数"] = y["取引数"].fillna(0).astype(int)
    print(y.to_string())
    if len(res.trades):
        print("\n=== 手仕舞い理由別 ===")
        g = res.trades.groupby("reason")
        print(pd.DataFrame({"回数": g.size(), "勝率": g.apply(lambda t: (t["pnl"] > 0).mean()),
                            "平均R": g["r"].mean()}).round(2).to_string())
    OUT.mkdir(exist_ok=True)
    res.trades.to_csv(OUT / "trades.csv", index=False)
    res.equity.to_csv(OUT / "equity.csv", header=["equity"])
    print(f"\n取引明細: {OUT / 'trades.csv'}　資産推移: {OUT / 'equity.csv'}")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="jpswing")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--start", default="2016-01-01")
    f.add_argument("--end")
    f.add_argument("--yfinance", help="J-Quants を使わず yfinance で取得する銘柄コード（カンマ区切り）")
    for name in ["backtest", "demo"]:
        b = sub.add_parser(name)
        b.add_argument("--start")
        b.add_argument("--end")
        b.add_argument("--capital", type=float, default=3_000_000)
    o = sub.add_parser("orders")
    o.add_argument("--equity", type=float, required=True, help="口座の評価額（現金＋株式）")
    o.add_argument("--cash", type=float, required=True, help="買付余力")
    o.add_argument("--positions", default="positions.csv")
    o.add_argument("--date", help="基準日（省略時はデータの最新日）")
    args = ap.parse_args(argv)

    if args.cmd == "fetch":
        if args.yfinance:
            data.fetch_yfinance(args.yfinance.split(","), args.start)
        else:
            data.fetch_all(args.start, args.end)
    elif args.cmd == "backtest":
        _backtest(data.load_all(), args)
    elif args.cmd == "demo":
        print("架空データで動作確認をします（結果の数字に意味はありません）")
        _backtest(synthetic.make(), args)
    elif args.cmd == "orders":
        m = strategy.build(data.load_all(), Config())
        pos = orders.load_positions(args.positions)
        o = orders.make(m, pos, args.equity, args.cash, args.date)
        md = orders.to_markdown(o)
        OUT.mkdir(exist_ok=True)
        stem = f"orders_{o['date']:%Y%m%d}"
        (OUT / f"{stem}.md").write_text(md, encoding="utf-8")
        pd.DataFrame(o["buys"]).to_csv(OUT / f"{stem}_buys.csv", index=False)
        o["candidates"].head(30).to_csv(OUT / f"{stem}_candidates.csv", index=False)
        if pos:
            orders.save_positions(pos, args.positions)  # 逆指値を更新。売れた銘柄の行は自分で削除する
        print(md)


if __name__ == "__main__":
    main()
