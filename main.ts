// Entrypoint: run the Second-Wind Dip-Recovery strategy on the harness wire.
// The harness speaks agent-fun/replay/v2 on stdin/stdout; the vendored shim
// owns the wire, this file only wires the strategy in and reports the end.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
  onDone(state) {
    const cashSol = Number(state.cash) / 1e9;
    console.error(`done: cash ${cashSol.toFixed(6)} SOL, positions ${state.positions.size}, curves ${state.curves.size}`);
  },
});
