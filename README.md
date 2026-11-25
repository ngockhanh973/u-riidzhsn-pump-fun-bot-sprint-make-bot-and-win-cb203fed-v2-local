[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v2-local/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v2-local/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint — Second-Wind Dip-Recovery (v2-local)

A replay bot for the make.fun "Pump.fun Bot Sprint" bounty. It trades pump.fun
bonding curves on the 6h dev window and is scored on net PnL in the final window.

## Strategy

Don't chase freshly created coins — they rug or never run. Only buy a coin that
has already proved it can run (price once doubled from creation) and is now
pulling back 12–30% off its peak while buyers are coming back in.

Entry (all must hold):

- The creator has sold less than 0.5 SOL in total (at or above that, the coin
  is vetoed for good).
- At least 200 slots since creation.
- Peak price at least 2x the creation price; peak real SOL at least 5, current
  real SOL at least 3.
- Current price / peak price between 0.70 and 0.88.
- In the last 20 slots: at least 3 buys from at least 3 distinct buyers, net
  flow at least +0.02 SOL, the newest trade is a buy, and no single buyer
  took more than 50% of the buy SOL.

Sizing: first buy 0.05 SOL; one add of 0.10 SOL when the price is up 5% from
the first buy and flow is still positive (max 0.30 SOL per coin, max 2 entries
per coin, 150-slot cooldown after an exit, max 5 main positions, 3.5 SOL total
exposure).

Exits (checked before any new entry each batch): sell everything if the
creator's cumulative sells reach 0.5 SOL, value drops 12% under cost, the
trailing stop gives back 10% from the best value after the first take-profit,
value reaches +50% after the first take-profit, 15-slot net flow falls below
−0.05 SOL, or the hold runs past 800 slots (1,600 while up 20%+). Sell half
once at +15%. Sells use 10,000 bps slippage; position value is marked net of
the 1.25% fee and the tx fee.

Pacing probe: if coins filled or fills lag the 4-hour schedule (22 coins /
100 fills), buy a 0.01 SOL probe on one recently traded liquid coin and sell
it as soon as it fills.

Everything is deterministic: decisions come only from the harness batches plus
the strategy's own state — no clock, no randomness, no environment, no I/O.

## Layout

- `main.ts` — entrypoint (`node main.ts` under the grader).
- `strategy.ts` — the strategy and `DEFAULT_PARAMS`.
- `vendor/makefun-bot.ts` — the kit's bot shim (vendored, byte-identical).

## Dev backtest

From `pump-sim-v2/` (scratch, outside this repo):

```
node tools/backtest.ts ../../pumpfun-kit/extracted/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-kit
```

Dev-window result (measured, run twice, identical both times): net
−0.084910 SOL, 129 fills, 39 coins, 62 trips, 6 wins, max drawdown 0.0085,
0 rejected, 3 failed txs; without failed txs −0.084592 SOL; at 2x fees
−0.146414 SOL. Guardrails pass: 39 coins ≥ 20, drawdown 0.0085 ≤ 0.50.
(For reference, the v1 rebuild target was net −0.102616 SOL, 137 fills,
39 coins, 66 trips, 5 wins, drawdown 0.0103, 0 rejected, 3 failed txs.)
