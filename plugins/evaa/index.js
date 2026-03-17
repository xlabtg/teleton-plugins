/**
 * EVAA Protocol plugin -- Lending & borrowing on TON
 *
 * Supply, borrow, withdraw, repay, and liquidate across 4 EVAA pools.
 * Uses @evaafi/sdk for on-chain interactions and oracle prices.
 * Agent wallet at ~/.teleton/wallet.json signs all write transactions.
 */

import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// CJS dependencies
// ---------------------------------------------------------------------------

const _require = createRequire(realpathSync(process.argv[1]));       // core: @ton/core, @ton/ton, @ton/crypto
const _pluginRequire = createRequire(import.meta.url);                // local: plugin-specific deps

const { Address, beginCell, toNano, Cell, SendMode, fromNano } = _require("@ton/core");
const { WalletContractV5R1, TonClient, internal } = _require("@ton/ton");
const { mnemonicToPrivateKey } = _require("@ton/crypto");

const evaa = _pluginRequire("@evaafi/sdk");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WALLET_FILE = join(homedir(), ".teleton", "wallet.json");
const MASTER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const POOL_MAP = {
  main: { config: evaa.MAINNET_POOL_CONFIG, MasterClass: evaa.EvaaMasterPyth, label: "Main (Pyth)" },
  lp: { config: evaa.MAINNET_LP_POOL_CONFIG, MasterClass: evaa.EvaaMasterClassic, label: "LP" },
  alts: { config: evaa.MAINNET_ALTS_POOL_CONFIG, MasterClass: evaa.EvaaMasterClassic, label: "Alts" },
  stable: { config: evaa.MAINNET_STABLE_POOL_CONFIG, MasterClass: evaa.EvaaMasterClassic, label: "Stable" },
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Cached TonClient + pool master instances */
let _client = null;
const _masterCache = new Map(); // poolKey -> { master, syncTime }

async function getTonClient() {
  if (_client) return _client;
  let endpoint;
  try {
    const { getHttpEndpoint } = _pluginRequire("@orbs-network/ton-access");
    endpoint = await getHttpEndpoint({ network: "mainnet" });
  } catch {
    endpoint = "https://toncenter.com/api/v2/jsonRPC";
  }
  _client = new TonClient({ endpoint });
  return _client;
}

/** Get or create a synced master contract for a pool. Caches for 5 min. */
async function getSyncedMaster(poolKey) {
  const entry = POOL_MAP[poolKey];
  if (!entry) throw new Error("Unknown pool: " + poolKey + ". Use: main, lp, alts, stable.");

  const cached = _masterCache.get(poolKey);
  if (cached && Date.now() - cached.syncTime < MASTER_CACHE_TTL) {
    return { master: cached.master, poolConfig: entry.config };
  }

  const client = await getTonClient();
  const master = client.open(new entry.MasterClass({ poolConfig: entry.config }));
  await master.getSync();

  _masterCache.set(poolKey, { master, syncTime: Date.now() });
  return { master, poolConfig: entry.config };
}

/** Get prices using the pool's built-in collector */
async function getPrices(poolConfig) {
  return await poolConfig.collector.getPrices();
}

/** Resolve asset by name from a pool config. Case-insensitive. */
function resolveAsset(poolConfig, assetName) {
  const target = assetName.toUpperCase();
  const asset = poolConfig.poolAssetsConfig.find(
    (a) => a.name.toUpperCase() === target
  );
  if (!asset) {
    const available = poolConfig.poolAssetsConfig.map((a) => a.name).join(", ");
    throw new Error("Asset '" + assetName + "' not found in pool. Available: " + available);
  }
  return asset;
}

/** Format bigint balance to human-readable string with decimals. */
function formatBalance(amount, decimals) {
  if (amount === 0n) return "0";
  const d = Number(decimals);
  const s = amount.toString().padStart(d + 1, "0");
  const intPart = s.slice(0, s.length - d) || "0";
  const fracPart = s.slice(s.length - d).replace(/0+$/, "");
  return fracPart ? intPart + "." + fracPart : intPart;
}

/** Format USD-scaled value (ASSET_PRICE_SCALE = 1e9). */
function formatUSD(value) {
  return "$" + formatBalance(value, 9n);
}

/** Parse a human-readable amount string to asset units. */
function parseAmount(amountStr, decimals) {
  const parts = amountStr.split(".");
  const intPart = parts[0] || "0";
  const fracPart = (parts[1] || "").padEnd(Number(decimals), "0").slice(0, Number(decimals));
  return BigInt(intPart + fracPart);
}

/** Read agent wallet, create TonClient, open wallet contract. */
async function getWalletAndClient() {
  let walletData;
  try {
    walletData = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
  } catch {
    throw new Error("Agent wallet not found at " + WALLET_FILE);
  }
  if (!walletData.mnemonic || !Array.isArray(walletData.mnemonic)) {
    throw new Error("Invalid wallet file: missing mnemonic array");
  }

  const keyPair = await mnemonicToPrivateKey(walletData.mnemonic);
  const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });

  const client = await getTonClient();
  const contract = client.open(wallet);

  return { wallet, keyPair, client, contract };
}

/** Create a Sender adapter for the SDK. */
function createSender(contract, keyPair) {
  return {
    address: contract.address,
    async send(args) {
      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({
            to: args.to,
            value: args.value,
            body: args.body,
            bounce: args.bounce ?? true,
          }),
        ],
      });
      return seqno;
    },
  };
}

/** Resolve pool key from parameter, default "main". */
function resolvePool(pool) {
  return (pool ?? "main").toLowerCase();
}

// ---------------------------------------------------------------------------
// Export (SDK v1.0.0)
// ---------------------------------------------------------------------------

export const manifest = {
  name: "evaa",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "EVAA Protocol lending and borrowing on TON — supply, borrow, withdraw, repay, and liquidate across multiple pools.",
};

export const tools = (sdk) => {
  const { log, ton } = sdk;

// ---------------------------------------------------------------------------
// Tool 1: evaa_markets
// ---------------------------------------------------------------------------

const evaaMarkets = {
  name: "evaa_markets",
  description:
    "Get EVAA lending market data: supply/borrow APY, utilization, TVL per asset. " +
    "Shows all pools or a specific pool (main, lp, alts, stable).",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      pool: {
        type: "string",
        enum: ["main", "lp", "alts", "stable"],
        description: "Pool to query (default: all pools)",
      },
    },
  },

  execute: async (params) => {
    try {
      const poolKeys = params.pool ? [resolvePool(params.pool)] : ["main", "lp", "alts", "stable"];
      const results = [];

      for (const poolKey of poolKeys) {
        const { master, poolConfig } = await getSyncedMaster(poolKey);
        const data = master.data;
        const mc = poolConfig.masterConstants;
        const assets = [];

        for (const asset of poolConfig.poolAssetsConfig) {
          const assetData = data.assetsData.get(asset.assetId);
          const assetConfig = data.assetsConfig.get(asset.assetId);
          const supplyApy = data.apy.supply.get(asset.assetId);
          const borrowApy = data.apy.borrow.get(asset.assetId);

          const totalSupplyPV = (assetData.sRate * assetData.totalSupply) / mc.FACTOR_SCALE;
          const totalBorrowPV = (assetData.bRate * assetData.totalBorrow) / mc.FACTOR_SCALE;
          const utilization =
            totalSupplyPV > 0n
              ? Number((totalBorrowPV * 10000n) / totalSupplyPV) / 100
              : 0;

          assets.push({
            name: asset.name,
            supply_apy: (supplyApy * 100).toFixed(2) + "%",
            borrow_apy: (borrowApy * 100).toFixed(2) + "%",
            utilization: utilization.toFixed(2) + "%",
            total_supply: formatBalance(totalSupplyPV, assetConfig.decimals),
            total_borrow: formatBalance(totalBorrowPV, assetConfig.decimals),
            tvl_balance: formatBalance(assetData.balance, assetConfig.decimals),
            decimals: Number(assetConfig.decimals),
          });
        }

        results.push({
          pool: poolKey,
          label: POOL_MAP[poolKey].label,
          master_address: poolConfig.masterAddress.toString(),
          assets,
        });
      }

      return { success: true, data: results };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: evaa_assets
// ---------------------------------------------------------------------------

const evaaAssets = {
  name: "evaa_assets",
  description:
    "List supported assets with their configurations: collateral factor, liquidation threshold, " +
    "borrow cap, reserve factor, origination fee, and more.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      pool: {
        type: "string",
        enum: ["main", "lp", "alts", "stable"],
        description: "Pool to query (default: main)",
      },
    },
  },

  execute: async (params) => {
    try {
      const poolKey = resolvePool(params.pool);
      const { master, poolConfig } = await getSyncedMaster(poolKey);
      const data = master.data;
      const mc = poolConfig.masterConstants;
      const assets = [];

      for (const asset of poolConfig.poolAssetsConfig) {
        const cfg = data.assetsConfig.get(asset.assetId);
        assets.push({
          name: asset.name,
          decimals: Number(cfg.decimals),
          collateral_factor: (Number(cfg.collateralFactor) / Number(mc.ASSET_COEFFICIENT_SCALE) * 100).toFixed(1) + "%",
          liquidation_threshold: (Number(cfg.liquidationThreshold) / Number(mc.ASSET_LIQUIDATION_THRESHOLD_SCALE) * 100).toFixed(1) + "%",
          liquidation_bonus: (Number(cfg.liquidationBonus) / Number(mc.ASSET_LIQUIDATION_BONUS_SCALE) * 100).toFixed(1) + "%",
          reserve_factor: (Number(cfg.reserveFactor) / Number(mc.ASSET_RESERVE_FACTOR_SCALE) * 100).toFixed(1) + "%",
          origination_fee: (Number(cfg.originationFee) / Number(mc.ASSET_ORIGINATION_FEE_SCALE) * 100).toFixed(4) + "%",
          borrow_cap: cfg.borrowCap === -1n ? "unlimited" : formatBalance(cfg.borrowCap < 0n ? -cfg.borrowCap : cfg.borrowCap, cfg.decimals),
          max_total_supply: formatBalance(cfg.maxTotalSupply, cfg.decimals),
        });
      }

      return { success: true, data: { pool: poolKey, assets } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: evaa_prices
// ---------------------------------------------------------------------------

const evaaPrices = {
  name: "evaa_prices",
  description:
    "Get current oracle prices for all assets in an EVAA pool. Prices in USD.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      pool: {
        type: "string",
        enum: ["main", "lp", "alts", "stable"],
        description: "Pool to query (default: main)",
      },
    },
  },

  execute: async (params) => {
    try {
      const poolKey = resolvePool(params.pool);
      const { poolConfig } = await getSyncedMaster(poolKey);
      const prices = await getPrices(poolConfig);
      const result = [];

      for (const asset of poolConfig.poolAssetsConfig) {
        const p = prices.dict.get(asset.assetId);
        result.push({
          name: asset.name,
          price_usd: p ? (Number(p) / 1e9).toFixed(6) : null,
          price_raw: p?.toString() ?? null,
        });
      }

      return { success: true, data: { pool: poolKey, prices: result } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: evaa_user_position
// ---------------------------------------------------------------------------

const evaaUserPosition = {
  name: "evaa_user_position",
  description:
    "Get a user's lending position: supply/borrow balances, health factor, " +
    "available to borrow, withdrawal limits. Defaults to agent wallet.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "TON wallet address (default: agent wallet)",
      },
      pool: {
        type: "string",
        enum: ["main", "lp", "alts", "stable"],
        description: "Pool to query (default: main)",
      },
    },
  },

  execute: async (params) => {
    try {
      if (params.address && !ton.validateAddress(params.address)) {
        return { success: false, error: `Invalid address: ${params.address}` };
      }
      const poolKey = resolvePool(params.pool);
      let userAddr;
      if (params.address) {
        userAddr = Address.parse(params.address);
      } else {
        const walletData = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
        userAddr = Address.parse(walletData.address);
      }

      const { master, poolConfig } = await getSyncedMaster(poolKey);
      const data = master.data;
      const client = await getTonClient();
      const prices = await getPrices(poolConfig);

      const userContract = master.getOpenedUserContract(client, userAddr);
      await userContract.getSync(data.assetsData, data.assetsConfig, prices.dict);

      const ud = userContract.data;
      if (!ud || ud.type === "inactive") {
        return {
          success: true,
          data: {
            pool: poolKey,
            address: userAddr.toString(),
            status: "inactive",
            message: "No active position in this pool.",
          },
        };
      }

      const balances = [];
      for (const asset of poolConfig.poolAssetsConfig) {
        const balance = ud.balances.get(asset.assetId);
        const cfg = data.assetsConfig.get(asset.assetId);
        if (!balance || balance.amount === 0n) continue;

        const withdrawLimit = ud.withdrawalLimits?.get(asset.assetId);
        const borrowLimit = ud.borrowLimits?.get(asset.assetId);

        balances.push({
          asset: asset.name,
          type: balance.type,
          amount: formatBalance(balance.amount, cfg.decimals),
          withdraw_limit: withdrawLimit !== undefined ? formatBalance(withdrawLimit, cfg.decimals) : null,
          borrow_limit: borrowLimit !== undefined ? formatBalance(borrowLimit, cfg.decimals) : null,
        });
      }

      return {
        success: true,
        data: {
          pool: poolKey,
          address: userAddr.toString(),
          status: "active",
          health_factor: ud.healthFactor?.toFixed(4),
          supply_balance_usd: formatUSD(ud.supplyBalance),
          borrow_balance_usd: formatUSD(ud.borrowBalance),
          available_to_borrow_usd: formatUSD(ud.availableToBorrow),
          limit_used_percent: ud.limitUsedPercent?.toFixed(2) + "%",
          is_liquidatable: ud.liquidationData?.liquidable ?? false,
          balances,
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: evaa_predict
// ---------------------------------------------------------------------------

const evaaPredict = {
  name: "evaa_predict",
  description:
    "Simulate how supply/withdraw/borrow/repay would affect your health factor. " +
    "Returns predicted health factor before and after the action.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["supply", "withdraw", "borrow", "repay"],
        description: "Action to simulate",
      },
      asset: {
        type: "string",
        description: "Asset name (e.g. 'TON', 'USDT')",
      },
      amount: {
        type: "string",
        description: "Amount in human units (e.g. '100' for 100 USDT)",
      },
      address: {
        type: "string",
        description: "TON wallet address (default: agent wallet)",
      },
      pool: {
        type: "string",
        enum: ["main", "lp", "alts", "stable"],
        description: "Pool (default: main)",
      },
    },
    required: ["action", "asset", "amount"],
  },

  execute: async (params) => {
    try {
      if (params.address && !ton.validateAddress(params.address)) {
        return { success: false, error: `Invalid address: ${params.address}` };
      }
      const poolKey = resolvePool(params.pool);
      let userAddr;
      if (params.address) {
        userAddr = Address.parse(params.address);
      } else {
        const walletData = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
        userAddr = Address.parse(walletData.address);
      }

      const { master, poolConfig } = await getSyncedMaster(poolKey);
      const data = master.data;
      const client = await getTonClient();
      const prices = await getPrices(poolConfig);

      const assetConfig = resolveAsset(poolConfig, params.asset);
      const assetCfg = data.assetsConfig.get(assetConfig.assetId);
      const assetData = data.assetsData.get(assetConfig.assetId);
      const amount = parseAmount(params.amount, assetCfg.decimals);

      const userContract = master.getOpenedUserContract(client, userAddr);
      await userContract.getSync(data.assetsData, data.assetsConfig, prices.dict);

      const ud = userContract.data;
      const principals = ud && ud.type === "active" ? ud.principals : evaa.Dictionary?.empty?.() ?? new Map();

      const actionMap = {
        supply: evaa.BalanceChangeType.Supply,
        withdraw: evaa.BalanceChangeType.Withdraw,
        borrow: evaa.BalanceChangeType.Borrow,
        repay: evaa.BalanceChangeType.Repay,
      };

      const currentHealth = ud && ud.type === "active" ? ud.healthFactor : 1;
      const predictedHealth = evaa.predictHealthFactor({
        principals,
        prices: prices.dict,
        assetsData: data.assetsData,
        assetsConfig: data.assetsConfig,
        poolConfig,
        asset: assetConfig,
        amount,
        balanceChangeType: actionMap[params.action],
      });

      const predictedApy = evaa.predictAPY({
        assetConfig: assetCfg,
        assetData,
        masterConstants: poolConfig.masterConstants,
        amount,
        balanceChangeType: actionMap[params.action],
      });

      return {
        success: true,
        data: {
          pool: poolKey,
          action: params.action,
          asset: params.asset,
          amount: params.amount,
          current_health_factor: currentHealth.toFixed(4),
          predicted_health_factor: predictedHealth.toFixed(4),
          predicted_supply_apy: (predictedApy.supplyApy * 100).toFixed(2) + "%",
          predicted_borrow_apy: (predictedApy.borrowApy * 100).toFixed(2) + "%",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: evaa_liquidations
// ---------------------------------------------------------------------------

const evaaLiquidations = {
  name: "evaa_liquidations",
  description:
    "Check if a position is liquidatable and compute liquidation parameters " +
    "(greatest loan, greatest collateral, amounts).",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "TON wallet address to check",
      },
      pool: {
        type: "string",
        enum: ["main", "lp", "alts", "stable"],
        description: "Pool to query (default: main)",
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      if (!ton.validateAddress(params.address)) {
        return { success: false, error: `Invalid address: ${params.address}` };
      }
      const poolKey = resolvePool(params.pool);
      const userAddr = Address.parse(params.address);

      const { master, poolConfig } = await getSyncedMaster(poolKey);
      const data = master.data;
      const client = await getTonClient();
      const prices = await getPrices(poolConfig);

      const userContract = master.getOpenedUserContract(client, userAddr);
      await userContract.getSync(data.assetsData, data.assetsConfig, prices.dict);

      const ud = userContract.data;
      if (!ud || ud.type === "inactive") {
        return {
          success: true,
          data: { pool: poolKey, address: params.address, liquidatable: false, reason: "No active position." },
        };
      }

      const liqData = ud.liquidationData;
      if (!liqData) {
        return {
          success: true,
          data: { pool: poolKey, address: params.address, liquidatable: false, reason: "Could not compute liquidation data." },
        };
      }

      const result = {
        pool: poolKey,
        address: params.address,
        liquidatable: liqData.liquidable,
        health_factor: ud.healthFactor?.toFixed(4),
        total_debt_usd: formatUSD(liqData.totalDebt),
        total_limit_usd: formatUSD(liqData.totalLimit),
      };

      if (liqData.liquidable) {
        result.greatest_loan_asset = liqData.greatestLoanAsset?.name;
        result.greatest_loan_value_usd = formatUSD(liqData.greatestLoanValue);
        result.greatest_collateral_asset = liqData.greatestCollateralAsset?.name;
        result.greatest_collateral_value_usd = formatUSD(liqData.greatestCollateralValue);
        if (liqData.liquidationAmount) {
          const loanCfg = data.assetsConfig.get(liqData.greatestLoanAsset.assetId);
          result.liquidation_amount = formatBalance(liqData.liquidationAmount, loanCfg.decimals);
        }
        if (liqData.minCollateralAmount) {
          const colCfg = data.assetsConfig.get(liqData.greatestCollateralAsset.assetId);
          result.min_collateral_amount = formatBalance(liqData.minCollateralAmount, colCfg.decimals);
        }
      }

      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 7: evaa_supply
// ---------------------------------------------------------------------------

const evaaSupply = {
  name: "evaa_supply",
  description:
    "Supply TON or a jetton to an EVAA lending pool to earn interest.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      asset: {
        type: "string",
        description: "Asset name (e.g. 'TON', 'USDT', 'stTON')",
      },
      amount: {
        type: "string",
        description: "Amount to supply in human units (e.g. '10' for 10 TON)",
      },
      pool: {
        type: "string",
        enum: ["main", "lp", "alts", "stable"],
        description: "Pool (default: main)",
      },
    },
    required: ["asset", "amount"],
  },

  execute: async (params) => {
    try {
      const poolKey = resolvePool(params.pool);
      const { master, poolConfig } = await getSyncedMaster(poolKey);
      const data = master.data;
      const { wallet, keyPair, client, contract } = await getWalletAndClient();

      const assetPoolCfg = resolveAsset(poolConfig, params.asset);
      const assetCfg = data.assetsConfig.get(assetPoolCfg.assetId);
      const amount = parseAmount(params.amount, assetCfg.decimals);
      const isTon = evaa.isTonAsset(assetPoolCfg);

      const sender = createSender(contract, keyPair);
      const value = isTon
        ? toNano("0.3") + BigInt(amount)
        : toNano("0.3");

      const openedMaster = client.open(new (POOL_MAP[poolKey].MasterClass)({ poolConfig }));
      await openedMaster.getSync();

      await openedMaster.sendSupply(client.provider(openedMaster.address), sender, value, {
        queryID: 0n,
        includeUserCode: true,
        amount: BigInt(amount),
        userAddress: wallet.address,
        asset: assetPoolCfg,
        payload: Cell.EMPTY,
        returnRepayRemainingsFlag: false,
        customPayloadRecipient: null,
        customPayloadSaturationFlag: false,
      });

      log.info(`Supply ${params.amount} ${params.asset} to ${poolKey} pool`);
      return {
        success: true,
        data: {
          pool: poolKey,
          asset: params.asset,
          amount: params.amount,
          wallet_address: wallet.address.toString(),
          message: "Supply tx sent. Check position after ~15 seconds with evaa_user_position.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 8: evaa_withdraw
// ---------------------------------------------------------------------------

const evaaWithdraw = {
  name: "evaa_withdraw",
  description:
    "Withdraw supplied assets from an EVAA lending pool.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      asset: {
        type: "string",
        description: "Asset name to withdraw (e.g. 'TON', 'USDT')",
      },
      amount: {
        type: "string",
        description: "Amount to withdraw in human units (e.g. '5' for 5 TON). Use 'max' for maximum.",
      },
      pool: {
        type: "string",
        enum: ["main", "lp", "alts", "stable"],
        description: "Pool (default: main)",
      },
    },
    required: ["asset", "amount"],
  },

  execute: async (params) => {
    try {
      const poolKey = resolvePool(params.pool);
      const { master, poolConfig } = await getSyncedMaster(poolKey);
      const data = master.data;
      const { wallet, keyPair, client, contract } = await getWalletAndClient();

      const assetPoolCfg = resolveAsset(poolConfig, params.asset);
      const assetCfg = data.assetsConfig.get(assetPoolCfg.assetId);
      const prices = await getPrices(poolConfig);

      // Get user data to determine amount and prices needed
      const userContract = master.getOpenedUserContract(client, wallet.address);
      await userContract.getSync(data.assetsData, data.assetsConfig, prices.dict);
      const ud = userContract.data;

      let withdrawAmount;
      if (params.amount === "max" && ud && ud.type === "active") {
        const limit = ud.withdrawalLimits?.get(assetPoolCfg.assetId);
        withdrawAmount = limit ?? 0n;
      } else {
        withdrawAmount = parseAmount(params.amount, assetCfg.decimals);
      }

      if (withdrawAmount === 0n) {
        return { success: false, error: "Nothing to withdraw." };
      }

      // Get price data for withdraw (needed if user has borrows)
      const collector = poolConfig.collector;
      const principals = ud && ud.type === "active" ? ud.realPrincipals : null;

      let pythData = undefined;
      if (principals) {
        try {
          const withdrawPrices = await collector.getPricesForWithdraw(principals, assetPoolCfg);
          if (withdrawPrices && withdrawPrices.dataCell) {
            pythData = {
              priceData: withdrawPrices.binaryUpdate ?? withdrawPrices.dataCell,
              targetFeeds: withdrawPrices.targetFeeds ?? [],
              refAssets: withdrawPrices.refAssets ?? [],
              publishGap: 60n,
              maxStaleness: 180n,
              minPublishTime: withdrawPrices.minPublishTime ? BigInt(withdrawPrices.minPublishTime) : 0n,
              maxPublishTime: withdrawPrices.maxPublishTime ? BigInt(withdrawPrices.maxPublishTime) : 0n,
              pythAddress: evaa.PYTH_ORACLE_MAINNET,
            };
          }
        } catch (e) {
          log.warn("Pyth oracle prices unavailable for withdraw:", e?.message ?? e);
        }
      }

      const sender = createSender(contract, keyPair);
      const openedMaster = client.open(new (POOL_MAP[poolKey].MasterClass)({ poolConfig }));
      await openedMaster.getSync();

      await openedMaster.sendWithdraw(client.provider(openedMaster.address), sender, toNano("0.5"), {
        queryID: 0n,
        includeUserCode: true,
        asset: assetPoolCfg,
        amount: withdrawAmount,
        userAddress: wallet.address,
        payload: Cell.EMPTY,
        subaccountId: 0,
        customPayloadSaturationFlag: false,
        returnRepayRemainingsFlag: false,
        pyth: pythData,
      });

      log.info(`Withdraw ${params.amount} ${params.asset} from ${poolKey} pool`);
      return {
        success: true,
        data: {
          pool: poolKey,
          asset: params.asset,
          amount: params.amount === "max" ? formatBalance(withdrawAmount, assetCfg.decimals) : params.amount,
          wallet_address: wallet.address.toString(),
          message: "Withdraw tx sent. Check position after ~15 seconds with evaa_user_position.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 9: evaa_borrow
// ---------------------------------------------------------------------------

const evaaBorrow = {
  name: "evaa_borrow",
  description:
    "Borrow an asset from an EVAA pool against your collateral. Requires a prior supply.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      asset: {
        type: "string",
        description: "Asset name to borrow (e.g. 'USDT', 'TON')",
      },
      amount: {
        type: "string",
        description: "Amount to borrow in human units (e.g. '500' for 500 USDT)",
      },
      pool: {
        type: "string",
        enum: ["main", "lp", "alts", "stable"],
        description: "Pool (default: main)",
      },
    },
    required: ["asset", "amount"],
  },

  execute: async (params) => {
    try {
      const poolKey = resolvePool(params.pool);
      const { master, poolConfig } = await getSyncedMaster(poolKey);
      const data = master.data;
      const { wallet, keyPair, client, contract } = await getWalletAndClient();

      const borrowAsset = resolveAsset(poolConfig, params.asset);
      const assetCfg = data.assetsConfig.get(borrowAsset.assetId);
      const borrowAmount = parseAmount(params.amount, assetCfg.decimals);

      // Borrow = supply 0 TON + withdraw borrowed asset
      // We use sendSupplyWithdraw: supply 0 of TON, withdraw borrowAmount of target asset
      const collector = poolConfig.collector;
      const prices = await getPrices(poolConfig);

      const userContract = master.getOpenedUserContract(client, wallet.address);
      await userContract.getSync(data.assetsData, data.assetsConfig, prices.dict);
      const ud = userContract.data;
      const principals = ud && ud.type === "active" ? ud.realPrincipals : null;

      // Need supply asset (TON with 0 amount) for the supplyWithdraw message
      const supplyAsset = resolveAsset(poolConfig, "TON");

      let pythData = undefined;
      if (principals) {
        try {
          const swPrices = await collector.getPricesForSupplyWithdraw(principals, supplyAsset, borrowAsset, true);
          if (swPrices && swPrices.dataCell) {
            pythData = {
              priceData: swPrices.binaryUpdate ?? swPrices.dataCell,
              targetFeeds: swPrices.targetFeeds ?? [],
              refAssets: swPrices.refAssets ?? [],
              publishGap: 60n,
              maxStaleness: 180n,
              minPublishTime: swPrices.minPublishTime ? BigInt(swPrices.minPublishTime) : 0n,
              maxPublishTime: swPrices.maxPublishTime ? BigInt(swPrices.maxPublishTime) : 0n,
              pythAddress: evaa.PYTH_ORACLE_MAINNET,
            };
          }
        } catch (e) {
          log.warn("Pyth oracle prices unavailable for borrow (primary):", e?.message ?? e);
        }
      }

      // If no prices from principals path, get fresh prices
      if (!pythData) {
        try {
          const freshPrices = await collector.getPrices();
          if (freshPrices && freshPrices.dataCell) {
            pythData = {
              priceData: freshPrices.binaryUpdate ?? freshPrices.dataCell,
              targetFeeds: freshPrices.targetFeeds ?? [],
              refAssets: freshPrices.refAssets ?? [],
              publishGap: 60n,
              maxStaleness: 180n,
              minPublishTime: freshPrices.minPublishTime ? BigInt(freshPrices.minPublishTime) : 0n,
              maxPublishTime: freshPrices.maxPublishTime ? BigInt(freshPrices.maxPublishTime) : 0n,
              pythAddress: evaa.PYTH_ORACLE_MAINNET,
            };
          }
        } catch (e) {
          log.warn("Pyth oracle prices unavailable for borrow (fallback):", e?.message ?? e);
        }
      }

      const sender = createSender(contract, keyPair);
      const openedMaster = client.open(new (POOL_MAP[poolKey].MasterClass)({ poolConfig }));
      await openedMaster.getSync();

      await openedMaster.sendSupplyWithdraw(client.provider(openedMaster.address), sender, toNano("0.5"), {
        queryID: 0n,
        includeUserCode: true,
        supplyAsset,
        supplyAmount: 0n,
        withdrawAsset: borrowAsset,
        withdrawAmount: borrowAmount,
        withdrawRecipient: wallet.address,
        userAddress: wallet.address,
        payload: Cell.EMPTY,
        subaccountId: 0,
        forwardAmount: undefined,
        customPayloadSaturationFlag: false,
        returnRepayRemainingsFlag: false,
        tonForRepayRemainings: 0n,
        pyth: pythData,
      });

      log.info(`Borrow ${params.amount} ${params.asset} from ${poolKey} pool`);
      return {
        success: true,
        data: {
          pool: poolKey,
          asset: params.asset,
          amount: params.amount,
          wallet_address: wallet.address.toString(),
          message: "Borrow tx sent. Check position after ~15 seconds with evaa_user_position.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 10: evaa_repay
// ---------------------------------------------------------------------------

const evaaRepay = {
  name: "evaa_repay",
  description:
    "Repay borrowed assets to an EVAA lending pool. Reduces your debt.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      asset: {
        type: "string",
        description: "Asset name to repay (e.g. 'USDT', 'TON')",
      },
      amount: {
        type: "string",
        description: "Amount to repay in human units (e.g. '100' for 100 USDT)",
      },
      pool: {
        type: "string",
        enum: ["main", "lp", "alts", "stable"],
        description: "Pool (default: main)",
      },
    },
    required: ["asset", "amount"],
  },

  execute: async (params) => {
    try {
      const poolKey = resolvePool(params.pool);
      const { master, poolConfig } = await getSyncedMaster(poolKey);
      const data = master.data;
      const { wallet, keyPair, client, contract } = await getWalletAndClient();

      const assetPoolCfg = resolveAsset(poolConfig, params.asset);
      const assetCfg = data.assetsConfig.get(assetPoolCfg.assetId);
      const amount = parseAmount(params.amount, assetCfg.decimals);
      const isTon = evaa.isTonAsset(assetPoolCfg);

      // Repay is done via supply (supplying the borrowed asset reduces debt)
      const sender = createSender(contract, keyPair);
      const value = isTon
        ? toNano("0.3") + BigInt(amount)
        : toNano("0.3");

      const openedMaster = client.open(new (POOL_MAP[poolKey].MasterClass)({ poolConfig }));
      await openedMaster.getSync();

      await openedMaster.sendSupply(client.provider(openedMaster.address), sender, value, {
        queryID: 0n,
        includeUserCode: true,
        amount: BigInt(amount),
        userAddress: wallet.address,
        asset: assetPoolCfg,
        payload: Cell.EMPTY,
        returnRepayRemainingsFlag: true,
        customPayloadRecipient: null,
        customPayloadSaturationFlag: false,
      });

      log.info(`Repay ${params.amount} ${params.asset} to ${poolKey} pool`);
      return {
        success: true,
        data: {
          pool: poolKey,
          asset: params.asset,
          amount: params.amount,
          wallet_address: wallet.address.toString(),
          message: "Repay tx sent. Excess will be returned. Check position after ~15 seconds with evaa_user_position.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 11: evaa_liquidate
// ---------------------------------------------------------------------------

const evaaLiquidate = {
  name: "evaa_liquidate",
  description:
    "Liquidate an undercollateralized position. Repay a portion of the borrower's debt " +
    "and receive collateral at a discount. Use evaa_liquidations first to check eligibility.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      borrower_address: {
        type: "string",
        description: "Address of the undercollateralized borrower",
      },
      pool: {
        type: "string",
        enum: ["main", "lp", "alts", "stable"],
        description: "Pool (default: main)",
      },
    },
    required: ["borrower_address"],
  },

  execute: async (params) => {
    try {
      if (!ton.validateAddress(params.borrower_address)) {
        return { success: false, error: `Invalid borrower address: ${params.borrower_address}` };
      }
      const poolKey = resolvePool(params.pool);
      const { master, poolConfig } = await getSyncedMaster(poolKey);
      const data = master.data;
      const { wallet, keyPair, client, contract } = await getWalletAndClient();
      const borrowerAddr = Address.parse(params.borrower_address);

      const prices = await getPrices(poolConfig);
      const userContract = master.getOpenedUserContract(client, borrowerAddr);
      await userContract.getSync(data.assetsData, data.assetsConfig, prices.dict);

      const ud = userContract.data;
      if (!ud || ud.type === "inactive") {
        return { success: false, error: "Borrower has no active position." };
      }
      if (!ud.liquidationData?.liquidable) {
        return { success: false, error: "Position is not liquidatable. Health factor: " + (ud.healthFactor?.toFixed(4) ?? "N/A") };
      }

      const liqData = ud.liquidationData;
      const loanAsset = liqData.greatestLoanAsset;
      const collateralAsset = liqData.greatestCollateralAsset;
      const loanCfg = data.assetsConfig.get(loanAsset.assetId);
      const isTonLoan = evaa.isTonAsset(loanAsset);

      // Get prices for liquidation
      const collector = poolConfig.collector;
      const liqPrices = await collector.getPricesForLiquidate(ud.realPrincipals);

      let pythData = undefined;
      if (liqPrices && liqPrices.dataCell) {
        pythData = {
          priceData: liqPrices.binaryUpdate ?? liqPrices.dataCell,
          targetFeeds: liqPrices.targetFeeds ?? [],
          refAssets: liqPrices.refAssets ?? [],
          publishGap: 60n,
          maxStaleness: 180n,
          minPublishTime: liqPrices.minPublishTime ? BigInt(liqPrices.minPublishTime) : 0n,
          maxPublishTime: liqPrices.maxPublishTime ? BigInt(liqPrices.maxPublishTime) : 0n,
          pythAddress: evaa.PYTH_ORACLE_MAINNET,
        };
      }

      const sender = createSender(contract, keyPair);
      const liquidationAmount = liqData.liquidationAmount;
      const minCollateralAmount = liqData.minCollateralAmount;

      const value = isTonLoan
        ? evaa.FEES.LIQUIDATION + BigInt(liquidationAmount)
        : evaa.FEES.LIQUIDATION_JETTON;

      const openedMaster = client.open(new (POOL_MAP[poolKey].MasterClass)({ poolConfig }));
      await openedMaster.getSync();

      await openedMaster.sendLiquidation(client.provider(openedMaster.address), sender, value, {
        queryID: 0n,
        includeUserCode: true,
        borrowerAddress: borrowerAddr,
        asset: loanAsset,
        collateralAsset: collateralAsset.assetId,
        liquidationAmount,
        minCollateralAmount,
        liquidatorAddress: wallet.address,
        payload: Cell.EMPTY,
        subaccountId: 0,
        customPayloadRecipient: null,
        customPayloadSaturationFlag: false,
        pyth: pythData,
      });

      log.info(`Liquidate ${params.borrower_address} in ${poolKey} pool, loan ${loanAsset.name}`);
      return {
        success: true,
        data: {
          pool: poolKey,
          borrower: params.borrower_address,
          loan_asset: loanAsset.name,
          collateral_asset: collateralAsset.name,
          liquidation_amount: formatBalance(liquidationAmount, loanCfg.decimals),
          wallet_address: wallet.address.toString(),
          message: "Liquidation tx sent. Check result after ~15 seconds.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

  return [
    evaaMarkets,
    evaaAssets,
    evaaPrices,
    evaaUserPosition,
    evaaPredict,
    evaaLiquidations,
    evaaSupply,
    evaaWithdraw,
    evaaBorrow,
    evaaRepay,
    evaaLiquidate,
  ];
}; // end tools(sdk)
