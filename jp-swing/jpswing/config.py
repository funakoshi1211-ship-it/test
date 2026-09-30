"""戦略のパラメータ。数値を変えたら必ず backtest で検証してから使うこと。"""
from dataclasses import dataclass, field, asdict


@dataclass
class Config:
    # --- 資金管理 ---
    risk_per_trade: float = 0.01      # 1トレードで失ってよい額（資金に対する割合）。損切りに掛かった時の損失
    max_positions: int = 8            # 同時保有の上限
    max_position_weight: float = 0.20  # 1銘柄の上限（資金に対する割合）
    max_per_sector: int = 2           # 同じ33業種の同時保有上限
    lot_size: int = 100               # 売買単位

    # --- 取引コスト（片道。手数料＋スリッページの見積り） ---
    cost_per_side: float = 0.001

    # --- 売買対象（流動性） ---
    min_price: float = 300.0
    min_turnover: float = 5e8         # 20日平均売買代金（円）。機関投資家が売買できる規模に絞る
    markets: tuple = ("プライム", "スタンダード")  # listed info の MarketCodeName に対する部分一致

    # --- 市場環境（TOPIX） ---
    regime_fast: int = 50
    regime_slow: int = 200
    foreign_flow_weeks: int = 4       # 海外投資家の現物ネット売買を何週合計で見るか

    # --- テクニカル条件（上昇トレンド中の押し目） ---
    near_high_pct: float = 0.15       # 52週高値から何%以内か
    rsi_low: float = 38.0
    rsi_high: float = 58.0
    min_rs_126: float = 0.0           # 6か月の対TOPIX超過リターンの下限

    # --- ファンダメンタル条件 ---
    min_fund_score: float = 55.0      # 0〜100
    max_per: float = 40.0
    earnings_blackout_days: int = 7   # 決算発表の何営業日前から新規買いを見送るか

    # --- 手仕舞い ---
    stop_atr: float = 2.0             # 初期損切り = 買値 - stop_atr × ATR
    trail_atr: float = 3.0            # トレーリング = 保有中の最高終値 - trail_atr × ATR
    breakeven_r: float = 1.0          # 含み益が何R に達したら損切りを買値へ引き上げるか
    take_profit_r: float = 0.0        # 0 なら利確目標なし（トレーリングで伸ばす）
    exit_below_sma: int = 50          # 終値がこの移動平均を下回ったら手仕舞い
    max_hold_days: int = 120          # 約半年（営業日）で時間切れ手仕舞い
    entry_limit_pct: float = 0.01     # 翌日の買い指値 = 前日終値 × (1 + この値)

    # --- スコアの重み ---
    w_momentum: float = 0.40
    w_fundamental: float = 0.35
    w_accumulation: float = 0.25

    extra: dict = field(default_factory=dict)

    def to_dict(self):
        return asdict(self)
