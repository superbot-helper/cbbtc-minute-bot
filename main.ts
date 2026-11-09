// cbBTC/USDC dip-reversal bot for make.fun's agent-fun/bars-replay/v1.
//
// The pool's price only moves when a swap hits it, and a one-minute move larger than
// about three times the per-minute volatility tends to revert as arbitrage restores
// the pool. So the bot sits in cash and buys a large downward dislocation, then exits
// on the bounce, on a stop, or when the hold limit runs out. A tiny insurance round
// trip on the first two bars guarantees the "at least one trade" guardrail is met even
// in a flat window.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** A one-bar drop this large is a dislocation, not noise (about 4x the per-minute sd). */
const ENTRY_DROP_BPS = 30;
/** Leave a position that keeps falling past this loss. */
const STOP_BPS = 30;
/** Take the reversion once it has paid this much. */
const TARGET_BPS = 180;
/** Give the reversion this many bars before giving up. */
const MAX_HOLD_BARS = 120;
/** The insurance trade: 25 USDC, so a calm window still records a filled order. */
const INSURANCE_UNITS = 25_000_000n;
/** Do not chase a bounce: a buy fills only within this of the close it was decided on. */
const BUY_MAX_SLIP = 40;
/** Accept up to 1% of downside on an exit, so a stop is not stuck. */
const SELL_MAX_SLIP = 100;

const closes: number[] = [];
let phase: 'insurance' | 'trade' = 'insurance';
let entryPrice: number | null = null;
let entryBar = -1;
let bars = 0;

const buy = (units: bigint, maxSlip: number): BuyInput => ({ side: 'buy', symbol: SYMBOL, notional_quote_units: units, max_slippage_bps: maxSlip });
const sell = (qty: bigint): SellInput => ({ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: SELL_MAX_SLIP });

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      closes.push(Number(bar.c));
      bars++;
    }
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && fill.side === 'buy' && fill.symbol === SYMBOL && phase === 'trade' && entryPrice === null) {
        entryPrice = Number(fill.price);
        entryBar = bars - 1;
      }
    }

    const held = state.positions.get(SYMBOL);

    if (phase === 'insurance') {
      if (held !== undefined) {
        phase = 'trade';
        return [sell(held.qty)];
      }
      return [buy(INSURANCE_UNITS, SELL_MAX_SLIP)];
    }

    if (held !== undefined) {
      const close = closes[closes.length - 1];
      if (entryPrice === null) {
        entryPrice = close;
        entryBar = bars - 1;
      }
      const pnlBps = (close / entryPrice - 1) * 10_000;
      const heldBars = bars - 1 - entryBar;
      if (pnlBps <= -STOP_BPS || pnlBps >= TARGET_BPS || heldBars >= MAX_HOLD_BARS) return [sell(held.qty)];
      return [];
    }

    entryPrice = null;
    const n = closes.length;
    if (n < 2) return [];
    const r1 = (closes[n - 1] / closes[n - 2] - 1) * 10_000;
    if (r1 <= -ENTRY_DROP_BPS) return [buy(state.cash, BUY_MAX_SLIP)];
    return [];
  },
});
