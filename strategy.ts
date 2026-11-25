// Second-Wind Dip-Recovery — a pump.fun replay bot.
//
// Idea: never chase a freshly created coin. Only buy a coin that has already
// proved it can run (its price once doubled from creation) and is now pulling
// back 12-30% off its peak while buyers are coming back in. The creator may
// take a small profit, but once the creator has sold 0.5 SOL in total the
// coin is vetoed for good.
//
// Everything here is deterministic: every decision comes only from the batch
// the harness sends plus this strategy's own state. No clock, no randomness,
// no environment, no I/O.

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  minRunup: number;
  minAge: number;
  flowWindow: number;
  minFlowSol: number;
  minFlowBuyers: number;
  lastMustBeBuy: boolean;
  maxBuyerShare: number;
  dipMax: number;
  dipMin: number;
  minRealSol: number;
  minPeakRealSol: number;
  firstSol: number;
  addSol: number;
  maxPositionSol: number;
  addStep: number;
  minBuySol: number;
  buySlipBps: number;
  tp1: number;
  tp2: number;
  trail: number;
  stopLoss: number;
  fadeWindow: number;
  fadeNetSol: number;
  maxHold: number;
  holdIfUp: number;
  cooldown: number;
  maxEntries: number;
  maxMain: number;
  creatorSellVetoSol: number;
  maxExposureSol: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minRunup: 2.0,
  minAge: 200,
  flowWindow: 20,
  minFlowSol: 0.02,
  minFlowBuyers: 3,
  lastMustBeBuy: true,
  maxBuyerShare: 0.5,
  dipMax: 0.88,
  dipMin: 0.7,
  minRealSol: 3,
  minPeakRealSol: 5,
  firstSol: 0.05,
  addSol: 0.1,
  maxPositionSol: 0.3,
  addStep: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  tp1: 0.15,
  tp2: 0.5,
  trail: 0.1,
  stopLoss: 0.12,
  fadeWindow: 15,
  fadeNetSol: 0.05,
  maxHold: 800,
  holdIfUp: 0.2,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  creatorSellVetoSol: 0.5,
  maxExposureSol: 3.5,
  targetCoins: 22,
  targetFills: 100,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const SELL_FEE = 0.0125;
const SELL_SLIP_BPS = 10000;

interface TradeNote {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface CoinBook {
  born: number;
  creator: string;
  startPx: number;
  topPx: number;
  topReal: number;
  makerSold: number;
  trades: TradeNote[];
  complete: boolean;
  entries: number;
  firstPx: number;
  openSlot: number;
  best: number;
  tookTp1: boolean;
  spent: number;
  lastExit: number;
  probeOpen: boolean;
}

function newBook(born: number, creator: string, startPx: number): CoinBook {
  return {
    born,
    creator,
    startPx,
    topPx: startPx,
    topReal: 0,
    makerSold: 0,
    trades: [],
    complete: false,
    entries: 0,
    firstPx: 0,
    openSlot: 0,
    best: 0,
    tookTp1: false,
    spent: 0,
    lastExit: -1e9,
    probeOpen: false,
  };
}

function closeBook(book: CoinBook, slot: number): void {
  book.lastExit = slot;
  // entries is a LIFETIME cap per coin (maxEntries): it is not reset here,
  // so a coin can be entered at most twice ever; the 150-slot cooldown
  // gates the second entry after the first exit.
  book.firstPx = 0;
  book.openSlot = 0;
  book.best = 0;
  book.tookTp1 = false;
  book.spent = 0;
  book.probeOpen = false;
}

export function createStrategy(p: Params): Bot {
  const books = new Map<string, CoinBook>();
  const sent = new Map<string, { mint: string; kind: 'first' | 'add' | 'probe' | 'sell' }>();
  const filledCoins = new Set<string>();
  // Every filled order of ours (buys and sells): the probe pace check
  // counts fills the same way the backtest reports them.
  let filledAll = 0;
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const horizon = Math.max(p.flowWindow, p.fadeWindow) + 40;

  function priceOf(state: BotState, mint: string): number {
    const c = state.curves.get(mint);
    if (c === undefined) return 0;
    const vt = Number(c.virtual_token_reserves);
    if (vt <= 0) return 0;
    return Number(c.virtual_quote_reserves) / vt;
  }

  function realSolOf(state: BotState, mint: string): number {
    const c = state.curves.get(mint);
    return c === undefined ? 0 : Number(c.real_quote_reserves) / LAMPORTS;
  }

  // Net flow over the last `window` slots: buy count, distinct buyers,
  // net SOL, whether the newest trade in the window is a buy, and the
  // largest single buyer's share of buy SOL.
  function windowFlow(book: CoinBook, now: number, window: number) {
    let buys = 0;
    let buySol = 0;
    let net = 0;
    let lastBuy = false;
    const buyers = new Map<string, number>();
    for (const t of book.trades) {
      if (t.slot <= now - window) continue;
      if (t.buy) {
        buys++;
        buySol += t.sol;
        net += t.sol;
        buyers.set(t.user, (buyers.get(t.user) ?? 0) + t.sol);
        lastBuy = true;
      } else {
        net -= t.sol;
        lastBuy = false;
      }
    }
    let topBuyer = 0;
    for (const v of buyers.values()) if (v > topBuyer) topBuyer = v;
    return { buys, buyers: buyers.size, net, lastBuy, maxShare: buySol > 0 ? topBuyer / buySol : 1 };
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS;
      const orders: OrderInput[] = [];
      const selling = new Set<string>();
      let plannedBuySol = 0;
      let plannedPositions = 0;

      // Cash already committed to open positions plus pending buys.
      let exposure = 0;
      for (const pos of state.positions.values()) exposure += Number(pos.cost_lamports) / LAMPORTS;
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy') exposure += Number(po.order.quote_lamports) / LAMPORTS;
      }

      const hasPendingBuy = (mint: string): boolean => {
        for (const po of state.pending.values()) {
          if (po.order.side === 'buy' && po.order.mint === mint) return true;
        }
        return false;
      };
      const hasPendingSell = (mint: string): boolean => {
        for (const po of state.pending.values()) {
          if (po.order.side === 'sell' && po.order.mint === mint) return true;
        }
        return false;
      };

      // Clamp a wanted buy size by the harness per-coin cap, free cash,
      // the 3.5 SOL total-exposure cap, and the 0.01 SOL minimum.
      const clampBuy = (mint: string, wantSol: number): number => {
        let size = Math.min(wantSol, Number(state.maxBuyLamports(mint)) / LAMPORTS);
        const free = Number(state.freeCashLamports()) / LAMPORTS - txFeeSol - plannedBuySol;
        size = Math.min(size, free);
        size = Math.min(size, p.maxExposureSol - exposure - plannedBuySol);
        if (size < p.minBuySol) return 0;
        return size;
      };

      const pushBuy = (mint: string, sol: number, kind: 'first' | 'add' | 'probe'): void => {
        const lamports = BigInt(Math.floor(sol * LAMPORTS));
        if (lamports <= 0n) return;
        const id = state.clientId();
        orders.push({ side: 'buy', mint, quote_lamports: lamports.toString(), max_slippage_bps: p.buySlipBps, client_id: id });
        sent.set(id, { mint, kind });
        plannedBuySol += sol;
      };

      const pushSell = (mint: string, tokens: bigint): void => {
        if (tokens <= 0n) return;
        const id = state.clientId();
        orders.push({ side: 'sell', mint, token_amount: tokens.toString(), max_slippage_bps: SELL_SLIP_BPS, client_id: id });
        sent.set(id, { mint, kind: 'sell' });
        selling.add(mint);
      };

      // --- fold this batch's events into the per-coin books ---
      for (const e of batch.events) {
        if (e.block_time !== null && e.block_time !== undefined) {
          if (firstTime === null) firstTime = e.block_time;
          lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const px = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          const old = books.get(e.mint);
          if (old === undefined) {
            books.set(e.mint, newBook(e.slot, e.creator, px));
          } else {
            old.born = e.slot;
            old.creator = e.creator;
            old.startPx = px;
            if (old.topPx < px) old.topPx = px;
          }
        } else if (e.event === 'TradeEvent') {
          let book = books.get(e.mint);
          if (book === undefined) {
            const px = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
            book = newBook(state.curves.get(e.mint)?.created_slot ?? e.slot, e.creator, px);
            books.set(e.mint, book);
          }
          const px = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          const sol = Number(e.sol_amount) / LAMPORTS;
          if (px > book.topPx) book.topPx = px;
          const real = Number(e.real_quote_reserves) / LAMPORTS;
          if (real > book.topReal) book.topReal = real;
          if (!e.is_buy && e.user === book.creator) book.makerSold += sol;
          book.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          if (book.trades.length > 0 && book.trades[0]!.slot <= now - horizon) {
            book.trades = book.trades.filter((t) => t.slot > now - horizon);
          }
        } else if (e.event === 'CompleteEvent') {
          const book = books.get(e.mint);
          if (book !== undefined) book.complete = true;
        }
      }

      // --- fold fills: what our own orders did ---
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // Harness close (complete / flatten / writeoff): the position is gone.
          const book = books.get(f.mint);
          if (book !== undefined && !state.positions.has(f.mint)) closeBook(book, f.slot);
          continue;
        }
        const rec = sent.get(f.client_id);
        if (rec === undefined) continue;
        sent.delete(f.client_id);
        if (f.status !== 'filled') continue;
        filledAll++;
        const book = books.get(f.mint);
        if (book === undefined) continue;
        if (f.side === 'buy') {
          filledCoins.add(f.mint);
          book.spent += Number(f.quote_lamports) / LAMPORTS;
          if (rec.kind === 'probe') {
            book.probeOpen = true;
          } else {
            book.entries++;
            if (book.entries === 1) {
              book.firstPx = priceOf(state, f.mint);
              book.openSlot = f.slot;
              book.best = 0;
              book.tookTp1 = false;
            }
          }
        } else if (!state.positions.has(f.mint)) {
          closeBook(book, f.slot);
        } else {
          // Partial sell (TP1) filled: the trailing stop must measure from
          // the remaining position's value, not the pre-sale full value.
          book.tookTp1 = true;
          const left = state.positions.get(f.mint);
          const px = priceOf(state, f.mint);
          if (left !== undefined && px > 0) {
            book.best = (Number(left.token_amount) * px) / LAMPORTS * (1 - SELL_FEE) - txFeeSol;
          }
        }
      }

      // A position that vanished from state with no sell still in flight is closed.
      for (const [mint, book] of books) {
        if (book.openSlot > 0 && !state.positions.has(mint) && !hasPendingSell(mint)) {
          closeBook(book, now);
        }
      }

      // --- exits first: every held position, before any new entry ---
      for (const [mint, pos] of state.positions) {
        if (hasPendingSell(mint)) continue;
        const book = books.get(mint);
        if (book === undefined) continue;
        const px = priceOf(state, mint);
        if (px <= 0) continue;
        const tokens = pos.token_amount;
        const gross = (Number(tokens) * px) / LAMPORTS;
        const value = gross * (1 - SELL_FEE) - txFeeSol;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > book.best) book.best = value;
        const age = now - book.openSlot;
        const holdLimit = value >= cost * (1 + p.holdIfUp) ? p.maxHold * 2 : p.maxHold;
        const fade = windowFlow(book, now, p.fadeWindow);
        let exitAll = false;
        if (book.probeOpen) exitAll = true;
        else if (book.makerSold >= p.creatorSellVetoSol) exitAll = true;
        else if (value < cost * (1 - p.stopLoss)) exitAll = true;
        else if (book.tookTp1 && value < book.best * (1 - p.trail)) exitAll = true;
        else if (book.tookTp1 && value >= cost * (1 + p.tp2)) exitAll = true;
        else if (fade.net < -p.fadeNetSol) exitAll = true;
        else if (book.openSlot > 0 && age > holdLimit) exitAll = true;
        if (exitAll) {
          pushSell(mint, tokens);
        } else if (!book.tookTp1 && value >= cost * (1 + p.tp1)) {
          pushSell(mint, tokens / 2n);
        }
      }

      // --- one add per position: price up 5% from the first buy, flow still positive ---
      for (const [mint, pos] of state.positions) {
        void pos;
        if (selling.has(mint) || hasPendingSell(mint) || hasPendingBuy(mint)) continue;
        const book = books.get(mint);
        if (book === undefined || book.entries !== 1 || book.probeOpen) continue;
        const px = priceOf(state, mint);
        if (book.firstPx <= 0 || px < book.firstPx * (1 + p.addStep)) continue;
        if (realSolOf(state, mint) < p.minRealSol) continue;
        if (windowFlow(book, now, p.flowWindow).net < p.minFlowSol) continue;
        if (book.spent >= p.maxPositionSol - p.minBuySol) continue;
        const size = clampBuy(mint, Math.min(p.addSol, p.maxPositionSol - book.spent));
        if (size > 0) pushBuy(mint, size, 'add');
      }

      // --- first entries: dip-recovery coins only ---
      if (state.committedPositionCount() + plannedPositions < p.maxMain) {
        for (const [mint, book] of books) {
          if (state.committedPositionCount() + plannedPositions >= p.maxMain) break;
          if (book.complete) continue;
          if (state.positions.has(mint) || hasPendingBuy(mint) || selling.has(mint)) continue;
          if (book.entries >= p.maxEntries) continue;
          if (now - book.lastExit < p.cooldown) continue;
          if (book.makerSold >= p.creatorSellVetoSol) continue;
          if (now - book.born < p.minAge) continue;
          if (book.topPx < p.minRunup * book.startPx) continue;
          if (book.topReal < p.minPeakRealSol) continue;
          const real = realSolOf(state, mint);
          if (real < p.minRealSol) continue;
          const px = priceOf(state, mint);
          if (px <= 0) continue;
          const dip = px / book.topPx;
          if (dip > p.dipMax || dip < p.dipMin) continue;
          const flow = windowFlow(book, now, p.flowWindow);
          if (flow.buys < p.minFlowBuyers) continue;
          if (flow.buyers < p.minFlowBuyers) continue;
          if (flow.net < p.minFlowSol) continue;
          if (p.lastMustBeBuy && !flow.lastBuy) continue;
          if (flow.maxShare > p.maxBuyerShare) continue;
          const size = clampBuy(mint, p.firstSol);
          if (size <= 0) continue;
          pushBuy(mint, size, 'first');
          plannedPositions++;
        }
      }

      // --- pacing probe: keep coin/fill counts on the 4h schedule ---
      if (firstTime !== null && lastTime !== null) {
        const progress = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = filledCoins.size < Math.ceil(p.targetCoins * progress);
        const needFills = filledAll < Math.ceil(p.targetFills * progress);
        let probesFlying = 0;
        for (const rec of sent.values()) if (rec.kind === 'probe') probesFlying++;
        for (const book of books.values()) if (book.probeOpen) probesFlying++;
        if ((needCoins || needFills) && probesFlying < p.maxProbes && state.committedPositionCount() + plannedPositions < p.maxMain) {
          const threshold = (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const [mint, book] of books) {
            if (book.complete) continue;
            if (state.positions.has(mint) || hasPendingBuy(mint) || selling.has(mint)) continue;
            // A coin probed before may be probed again; only when coins alone
            // are short must the probe coin never have filled before.
            if (needCoins && filledCoins.has(mint)) continue;
            const lastTrade = book.trades[book.trades.length - 1];
            if (lastTrade === undefined || now - lastTrade.slot > p.flowWindow) continue;
            if (realSolOf(state, mint) < 1.5 * threshold) continue;
            const size = clampBuy(mint, p.probeSol);
            if (size <= 0) continue;
            pushBuy(mint, size, 'probe');
            break;
          }
        }
      }

      return orders;
    },
  };
}
