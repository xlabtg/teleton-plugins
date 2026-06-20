/**
 * EVM wallet — Polygon key management and signing for Polymarket.
 *
 * Responsibilities:
 *   - resolve / generate the EVM private key (never logged, never returned)
 *   - derive the public address
 *   - sign Polymarket CTF Exchange orders (EIP-712)
 *   - build CLOB L2 (HMAC) authentication headers
 *
 * The private key lives only in sdk.secrets. generateKeypair() is a helper for
 * first-time setup: it returns a fresh address + key so the user can store the
 * key as a secret, exactly as described in the issue.
 */

import { createHmac } from "node:crypto";

import { eip712Digest } from "./crypto/eip712.js";
import { keccak256 } from "./crypto/keccak.js";
import { bytesToHex, concatBytes, hexToBytes } from "./crypto/hex.js";
import { rlpEncode, toMinimalBytes } from "./crypto/rlp.js";
import { generatePrivateKey, privateKeyToAddress, sign, signToHex } from "./crypto/secp256k1.js";

// EIP-712 type for the Polymarket CTF Exchange order.
const ORDER_FIELDS = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "taker", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "expiration", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "feeRateBps", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class EvmWallet {
  /**
   * @param {object} opts
   * @param {string} opts.privateKey 0x-prefixed 32-byte hex
   */
  constructor({ privateKey }) {
    if (!privateKey) throw new Error("evm_private_key is required");
    this._privateKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    this.address = privateKeyToAddress(this._privateKey);
  }

  /**
   * Sign a Polymarket order struct via EIP-712.
   * @param {object} order order fields (salt..signatureType)
   * @param {{ chainId: number, verifyingContract: string }} domainInfo
   * @returns {string} 65-byte signature hex
   */
  signOrder(order, { chainId, verifyingContract }) {
    const domain = {
      name: "Polymarket CTF Exchange",
      version: "1",
      chainId,
      verifyingContract,
    };
    const message = {
      salt: order.salt,
      maker: order.maker,
      signer: order.signer ?? order.maker,
      taker: order.taker ?? ZERO_ADDRESS,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      expiration: order.expiration ?? 0,
      nonce: order.nonce ?? 0,
      feeRateBps: order.feeRateBps ?? 0,
      side: order.side,
      signatureType: order.signatureType ?? 0,
    };
    const digest = eip712Digest(domain, "Order", ORDER_FIELDS, message);
    return signToHex(digest, this._privateKey);
  }

  /**
   * Sign an EIP-1559 (type-2) Polygon transaction.
   * @param {object} tx
   * @param {number} tx.chainId
   * @param {number|bigint} tx.nonce
   * @param {bigint} tx.maxPriorityFeePerGas (wei)
   * @param {bigint} tx.maxFeePerGas (wei)
   * @param {number|bigint} tx.gasLimit
   * @param {string} tx.to 0x address
   * @param {bigint} [tx.value] (wei)
   * @param {string} [tx.data] 0x-prefixed call data
   * @returns {string} 0x-prefixed raw signed transaction
   */
  signTransaction(tx) {
    const fields = [
      toMinimalBytes(tx.chainId),
      toMinimalBytes(tx.nonce),
      toMinimalBytes(tx.maxPriorityFeePerGas),
      toMinimalBytes(tx.maxFeePerGas),
      toMinimalBytes(tx.gasLimit),
      hexToBytes(tx.to),
      toMinimalBytes(tx.value ?? 0n),
      tx.data ? hexToBytes(tx.data) : new Uint8Array(0),
      [], // empty accessList
    ];
    const TYPE = new Uint8Array([0x02]);
    const unsigned = concatBytes(TYPE, rlpEncode(fields));
    const digest = keccak256(unsigned);
    const { r, s, recovery } = sign(digest, this._privateKey);
    const signed = concatBytes(
      TYPE,
      rlpEncode([
        ...fields,
        toMinimalBytes(recovery), // yParity
        toMinimalBytes(r),
        toMinimalBytes(s),
      ])
    );
    return bytesToHex(signed);
  }

  /**
   * Build CLOB L2 (HMAC) auth headers.
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.secret base64url-encoded HMAC secret
   * @param {string} opts.passphrase
   * @param {string} opts.method HTTP method
   * @param {string} opts.path request path (e.g. "/order")
   * @param {string} [opts.body] serialised request body
   * @param {number} [opts.timestamp] unix seconds (injectable for tests)
   */
  buildL2Headers({ apiKey, secret, passphrase, method, path, body = "", timestamp }) {
    const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
    const message = `${ts}${method}${path}${body}`;
    const key = Buffer.from(secret, "base64url");
    // HMAC-SHA256 — это обязательная схема подписи запросов Polymarket CLOB L2
    // (идентична Coinbase Pro): подписывается строка запроса ключом API-секрета.
    // Это НЕ хеширование пароля для хранения, поэтому правило CodeQL
    // js/insufficient-password-hash (CWE-916) здесь — ложное срабатывание.
    const signature = createHmac("sha256", key).update(message).digest("base64url");
    return {
      POLY_ADDRESS: this.address,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: ts,
      POLY_API_KEY: apiKey,
      POLY_PASSPHRASE: passphrase,
    };
  }
}

/**
 * Generate a fresh EVM keypair for first-time setup.
 * @returns {{ address: string, privateKey: string }}
 */
export function generateKeypair() {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAddress(privateKey), privateKey };
}
