/**
 * GiftIndex plugin -- monitor and trade the Telegram Gifts index on TON
 *
 * Aggregates gift collection floor prices, calculates fair value,
 * and trades GHOLD/FLOOR tokens via on-chain order books.
 *
 * Trading workflow guardrails (manager rules):
 *   1. Owner-only access (non-owners are refused)
 *   2. Sell minimum $2, displayed price includes 10% fee
 *   3. Buy existing orders only, whole lots, auto-split if needed
 *   4. Orders must be within oracle corridor, minimum $1
 *   5. Out-of-corridor advisory in portfolio view
 *   6. Cashback reminder after each purchase
 *   7. Post-trade seqno verification
 */

import {
  initMarket,
  getMarketOverview,
  getGiftstatFloors,
  getGiftstatCollections,
  calculateFairValue,
  getOnChainPrices,
  getActiveOrders,
  ORDER_BOOKS,
  PRICE_SCALE,
} from './market.js';

import {
  initTrade,
  placeBidOrder,
  placeAskOrder,
  cancelOrder,
  verifySeqnoAdvanced,
} from './trade.js';

import {
  assertOwner,
  assertInCorridor,
  assertMinimumValue,
  GuardError,
} from './guards.js';

// ---------------------------------------------------------------------------
// Export (SDK v1.0.0)
// ---------------------------------------------------------------------------

export const manifest = {
  name: "giftindex",
  version: "2.0.0",
  sdkVersion: ">=1.0.0",
  description: "GiftIndex ODROB trading — monitor and trade the Telegram Gifts index on TON with workflow guardrails.",
};

export const tools = (sdk) => {
  initMarket(sdk);
  initTrade(sdk);
  const { log } = sdk;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch corridor for a specific order book (returns {low, high} in USD). */
async function fetchCorridor(obKey) {
  const ob = ORDER_BOOKS[obKey];
  const prices = await getOnChainPrices(ob.address);
  return { low: prices.min_price, high: prices.max_price };
}

/** Format a GuardError or generic error for tool response. */
function formatError(err) {
  if (err instanceof GuardError) return { success: false, error: `[${err.code}] ${err.message}` };
  return { success: false, error: String(err.message || err).slice(0, 500) };
}

// ---------------------------------------------------------------------------
// Tool 1: giftindex_market (enhanced with order book depth)
// ---------------------------------------------------------------------------

const giftindexMarket = {
  name: 'giftindex_market',
  description:
    'Get GiftIndex market overview: TON/USDT rate, fair value, order book corridors, top asks/bids, and top 10 collections by market cap.',
  category: 'data-bearing',
  scope: 'always',

  parameters: {
    type: 'object',
    properties: {},
  },

  execute: async (_params, _context) => {
    try {
      const overview = await getMarketOverview();

      const lines = [];
      lines.push(`TON/USDT: ${overview.tonRate != null ? '$' + overview.tonRate.toFixed(4) : 'unavailable'}`);
      lines.push(`Fair Value: $${overview.fairValue.toFixed(4)}`);
      lines.push('');

      for (const [key, ob] of Object.entries(overview.orderBooks)) {
        const low = ob.corridor.low != null ? '$' + ob.corridor.low.toFixed(4) : 'n/a';
        const high = ob.corridor.high != null ? '$' + ob.corridor.high.toFixed(4) : 'n/a';
        lines.push(`${key} Order Book (${ob.address}):`);
        lines.push(`  Corridor: ${low} - ${high}`);
      }

      // Show top 5 asks and bids from each order book
      for (const [key] of Object.entries(ORDER_BOOKS)) {
        try {
          const orders = await getActiveOrders(ORDER_BOOKS[key].address);
          if (orders.asks.length > 0) {
            lines.push('');
            lines.push(`${key} Top Asks (sell orders available to buy):`);
            for (const ask of orders.asks.slice(0, 5)) {
              const tokens = (Number(ask.amount) / 1e9).toFixed(4);
              lines.push(`  $${ask.price.toFixed(4)} — ${tokens} tokens`);
            }
          }
          if (orders.bids.length > 0) {
            lines.push(`${key} Top Bids (buy orders):`);
            for (const bid of orders.bids.slice(0, 5)) {
              const tokens = (Number(bid.amount) / 1e9).toFixed(4);
              lines.push(`  $${bid.price.toFixed(4)} — ${tokens} tokens`);
            }
          }
          if (orders.error) {
            lines.push(`  (order book parse warning: ${orders.error})`);
          }
        } catch { /* non-critical */ }
      }

      if (overview.collections.length > 0) {
        lines.push('');
        lines.push('Top 10 Collections:');
        for (const c of overview.collections) {
          const floor = c.floor_price != null ? '$' + c.floor_price.toFixed(2) : 'n/a';
          const mcap = c.market_cap > 0 ? '$' + (c.market_cap / 1e6).toFixed(2) + 'M' : 'n/a';
          lines.push(`  ${c.collection}: floor ${floor}, mcap ${mcap}`);
        }
      }

      return { success: true, summary: lines.join('\n'), data: overview };
    } catch (err) {
      return formatError(err);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: giftindex_fair_value
// ---------------------------------------------------------------------------

const giftindexFairValue = {
  name: 'giftindex_fair_value',
  description:
    'Calculate the fair value of the GiftIndex token by aggregating floor prices of underlying Telegram Gift collections, weighted by market cap.',
  category: 'data-bearing',
  scope: 'always',

  parameters: {
    type: 'object',
    properties: {},
  },

  execute: async (_params, _context) => {
    try {
      const [floors, collections] = await Promise.all([
        getGiftstatFloors(),
        getGiftstatCollections(),
      ]);

      const { fairValue, components } = calculateFairValue(floors, collections);

      const sorted = [...components].sort((a, b) => b.weight - a.weight);
      const topComponents = sorted.slice(0, 15).map((c) => ({
        collection: c.collection,
        floor_price: c.floor_price,
        weight: c.weight,
      }));

      return {
        success: true,
        data: {
          fair_value: fairValue,
          top_components: topComponents,
          total_collections: components.length,
        },
      };
    } catch (err) {
      return formatError(err);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: giftindex_place_bid (BUY) — rewritten for Rule 3
// ---------------------------------------------------------------------------

const giftindexPlaceBid = {
  name: 'giftindex_place_bid',
  description:
    'Buy index tokens by matching existing sell orders in the order book. ' +
    'Automatically finds the best available asks, buys whole lots, and splits ' +
    'across multiple orders if needed. Owner only.',
  category: 'action',
  scope: 'admin-only',

  parameters: {
    type: 'object',
    properties: {
      order_book: { type: 'string', description: 'Which order book: "GHOLD" or "FLOOR"' },
      amount: { type: 'string', description: 'Target USDT amount to spend (e.g. "10" = ~10 USDT)' },
      max_price: { type: 'number', description: 'Optional: maximum price per token. Orders above this price are skipped.' },
    },
    required: ['order_book', 'amount'],
  },

  execute: async (params, context) => {
    try {
      // Rule 1: Owner only
      assertOwner(context);

      const obKey = params.order_book.toUpperCase();
      const ob = ORDER_BOOKS[obKey];
      if (!ob) return { success: false, error: `Unknown order book "${params.order_book}". Use "GHOLD" or "FLOOR".` };

      const targetUsdt = parseFloat(params.amount);
      if (!Number.isFinite(targetUsdt) || targetUsdt <= 0) {
        return { success: false, error: 'Invalid amount — must be a positive number.' };
      }

      // Rule 4: Minimum $1
      assertMinimumValue(targetUsdt, 1.0, 'Buy order');

      // Fetch corridor
      const corridor = await fetchCorridor(obKey);

      // Rule 3: Fetch existing sell orders (asks)
      const orderBook = await getActiveOrders(ob.address);
      if (orderBook.error && orderBook.asks.length === 0) {
        return { success: false, error: `Cannot read order book: ${orderBook.error}. Buy rejected for safety.` };
      }
      if (orderBook.asks.length === 0) {
        return { success: false, error: 'No sell orders available in the order book. Nothing to buy.' };
      }

      // Filter asks: within corridor, respect max_price
      const maxPrice = params.max_price ?? Infinity;
      const validAsks = orderBook.asks.filter((ask) => {
        if (ask.price > maxPrice) return false;
        if (corridor.low != null && corridor.high != null) {
          if (ask.price < corridor.low || ask.price > corridor.high) return false;
        }
        return true;
      });

      if (validAsks.length === 0) {
        return {
          success: false,
          error: 'No sell orders within corridor and price limits. Nothing to buy.',
          corridor: { low: corridor.low?.toFixed(4), high: corridor.high?.toFixed(4) },
        };
      }

      // Rule 3: Greedy order matching — whole lots, best price first
      const selected = [];
      let totalUsdt = 0;

      for (const ask of validAsks) {
        const tokenBase = BigInt(ask.amount);
        // token_base (9 dec) * priceScaled / PRICE_SCALE → token value in USDT base (9 dec)
        // then divide by 1e3 to get USDT base (6 dec)
        const usdtBase = tokenBase * BigInt(ask.priceScaled) / BigInt(PRICE_SCALE * 1000);
        const usdtHuman = Number(usdtBase) / 1e6;

        if (usdtHuman < 1.0) continue; // Rule 4: skip < $1 orders

        selected.push({ ...ask, usdtBase, usdtHuman });
        totalUsdt += usdtHuman;

        if (totalUsdt >= targetUsdt) break;
      }

      if (selected.length === 0) {
        return { success: false, error: 'No eligible orders found that meet minimum value ($1) requirements.' };
      }

      // Execute each bid sequentially (seqno verification between each)
      const results = [];
      for (const ask of selected) {
        try {
          const result = await placeBidOrder(ob.address, ask.usdtBase, ask.priceScaled);

          // Rule 7: Verify
          const verification = await verifySeqnoAdvanced(result.seqno);

          results.push({
            price: ask.price,
            usdt: ask.usdtHuman.toFixed(2),
            tokens: (Number(ask.amount) / 1e9).toFixed(4),
            seqno: result.seqno,
            confirmed: verification.confirmed,
            elapsed_ms: verification.elapsed,
          });
        } catch (err) {
          results.push({
            price: ask.price,
            usdt: ask.usdtHuman.toFixed(2),
            error: String(err.message || err).slice(0, 200),
          });
        }
      }

      const confirmedResults = results.filter((r) => r.confirmed);
      const totalSpent = confirmedResults.reduce((sum, r) => sum + parseFloat(r.usdt), 0);
      log.info(`Buy ${obKey}: matched ${selected.length} orders, confirmed ${confirmedResults.length}, spent $${totalSpent.toFixed(2)}`);

      return {
        success: true,
        data: {
          order_book: obKey,
          target_usdt: params.amount,
          orders_matched: selected.length,
          orders_confirmed: confirmedResults.length,
          total_usdt_spent: totalSpent.toFixed(2),
          corridor: { low: corridor.low?.toFixed(4), high: corridor.high?.toFixed(4) },
          fee_note: '10% fee automatically applied to each purchase.',
          executions: results,
          // Rule 6: Cashback reminder
          cashback_reminder: 'Check swap.coffee Claim Center within 1 hour for cashback.',
          weekly_reminder: 'Every Monday: check volume bonus eligibility at swap.coffee.',
        },
      };
    } catch (err) {
      return formatError(err);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: giftindex_place_ask (SELL) — guarded
// ---------------------------------------------------------------------------

const giftindexPlaceAsk = {
  name: 'giftindex_place_ask',
  description:
    'Place a SELL limit order on the GiftIndex order book. Owner only. ' +
    'Minimum $2 order value. Price must be within oracle corridor. ' +
    'Displayed price includes 10% platform fee.',
  category: 'action',
  scope: 'admin-only',

  parameters: {
    type: 'object',
    properties: {
      order_book: { type: 'string', description: 'Which order book: "GHOLD" or "FLOOR"' },
      amount: { type: 'string', description: 'Token amount in human units (e.g. "5" = 5 tokens)' },
      price: { type: 'number', description: 'Price in human units (e.g. 1.5 = $1.50). Includes 10% fee.' },
    },
    required: ['order_book', 'amount', 'price'],
  },

  execute: async (params, context) => {
    try {
      // Rule 1: Owner only
      assertOwner(context);

      const obKey = params.order_book.toUpperCase();
      const ob = ORDER_BOOKS[obKey];
      if (!ob) return { success: false, error: `Unknown order book "${params.order_book}". Use "GHOLD" or "FLOOR".` };

      const price = params.price;
      const amount = parseFloat(params.amount);
      if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price) || price <= 0) {
        return { success: false, error: 'Invalid amount or price — both must be positive numbers.' };
      }
      const orderValue = amount * price;

      // Rule 2: Minimum $2 sell order
      assertMinimumValue(orderValue, 2.0, 'Sell order');

      // Rule 4: Corridor check
      const corridor = await fetchCorridor(obKey);
      assertInCorridor(price, corridor, obKey);

      const amountBase = BigInt(Math.round(amount * 1e9));
      const priceScaled = Math.round(price * PRICE_SCALE);

      const result = await placeAskOrder(ob.address, amountBase, priceScaled);
      log.info(`Sell ${obKey}: ${params.amount} tokens @ $${params.price}`);

      // Rule 7: Post-trade verification
      const verification = await verifySeqnoAdvanced(result.seqno);

      return {
        success: true,
        data: {
          order_book: obKey,
          amount_tokens: params.amount,
          price: params.price,
          order_value_usdt: orderValue.toFixed(2),
          corridor: { low: corridor.low.toFixed(4), high: corridor.high.toFixed(4) },
          fee_note: 'Displayed price includes 10% platform fee.',
          seqno: result.seqno,
          wallet_address: result.walletAddress,
          jetton_wallet: result.jettonWalletAddress,
          confirmed: verification.confirmed,
          elapsed_ms: verification.elapsed,
          message: verification.confirmed
            ? 'Ask order confirmed on-chain.'
            : 'Ask order sent but confirmation timed out. Check status manually after ~30s.',
        },
      };
    } catch (err) {
      return formatError(err);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: giftindex_cancel — guarded
// ---------------------------------------------------------------------------

const giftindexCancel = {
  name: 'giftindex_cancel',
  description:
    'Cancel an existing order on the GiftIndex order book and reclaim tokens. Owner only.',
  category: 'action',
  scope: 'admin-only',

  parameters: {
    type: 'object',
    properties: {
      order_book: { type: 'string', description: 'Which order book: "GHOLD" or "FLOOR"' },
      query_id: { type: 'string', description: "The order's query ID" },
      order_type: { type: 'string', description: 'Order type to cancel: "buy" or "sell"' },
    },
    required: ['order_book', 'query_id', 'order_type'],
  },

  execute: async (params, context) => {
    try {
      // Rule 1: Owner only
      assertOwner(context);

      const ob = ORDER_BOOKS[params.order_book.toUpperCase()];
      if (!ob) return { success: false, error: `Unknown order book "${params.order_book}". Use "GHOLD" or "FLOOR".` };

      // orderType: 1 = cancel sell orders (bid), 2 = cancel buy orders (ask)
      const orderType = params.order_type === 'buy' ? 2 : 1;
      const result = await cancelOrder(ob.address, BigInt(params.query_id), 1, orderType);
      log.info(`Cancel ${params.order_book.toUpperCase()} ${params.order_type} order, query_id=${params.query_id}`);

      return {
        success: true,
        data: {
          order_book: params.order_book.toUpperCase(),
          query_id: params.query_id,
          seqno: result.seqno,
          wallet_address: result.walletAddress,
          message: 'Cancel order sent. Tokens should return after ~15 seconds.',
        },
      };
    } catch (err) {
      return formatError(err);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: giftindex_portfolio — enhanced with corridor advisory (Rule 5)
// ---------------------------------------------------------------------------

const giftindexPortfolio = {
  name: 'giftindex_portfolio',
  description:
    'View current GiftIndex market state: order book prices, corridors, corridor advisory, and top collections.',
  category: 'data-bearing',
  scope: 'always',

  parameters: {
    type: 'object',
    properties: {},
  },

  execute: async (_params, _context) => {
    try {
      const overview = await getMarketOverview();

      const lines = [];
      lines.push('=== GiftIndex Portfolio Overview ===');
      lines.push(`TON/USDT: ${overview.tonRate != null ? '$' + overview.tonRate.toFixed(4) : 'unavailable'}`);
      lines.push(`Fair Value: $${overview.fairValue.toFixed(4)}`);
      lines.push('');

      for (const [key, ob] of Object.entries(overview.orderBooks)) {
        const low = ob.corridor.low != null ? '$' + ob.corridor.low.toFixed(4) : 'n/a';
        const high = ob.corridor.high != null ? '$' + ob.corridor.high.toFixed(4) : 'n/a';
        lines.push(`${key}: corridor ${low} - ${high}`);
      }

      // Rule 5: Out-of-corridor advisory
      lines.push('');
      lines.push('Corridor Advisory:');
      for (const [key, ob] of Object.entries(overview.orderBooks)) {
        if (ob.corridor.low != null && ob.corridor.high != null) {
          const updateFreq = key === 'FLOOR' ? '1 hour' : '6 hours';
          lines.push(`  ${key}: $${ob.corridor.low.toFixed(4)} – $${ob.corridor.high.toFixed(4)} (updates every ${updateFreq})`);
          lines.push(`    Orders outside this range will not be matched.`);
          lines.push(`    If your order is out of range: cancel + re-place at new price, or wait for corridor shift.`);
        }
      }

      if (overview.collections.length > 0) {
        lines.push('');
        lines.push('Top collections:');
        for (const c of overview.collections.slice(0, 5)) {
          const floor = c.floor_price != null ? '$' + c.floor_price.toFixed(2) : 'n/a';
          lines.push(`  ${c.collection}: ${floor}`);
        }
      }

      return {
        success: true,
        summary: lines.join('\n'),
        data: overview,
        note: 'Balance tracking not yet implemented. Shows market state for position assessment.',
      };
    } catch (err) {
      return formatError(err);
    }
  },
};

  return [
    giftindexMarket,
    giftindexFairValue,
    giftindexPlaceBid,
    giftindexPlaceAsk,
    giftindexCancel,
    giftindexPortfolio,
  ];
}; // end tools(sdk)
