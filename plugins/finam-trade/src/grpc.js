import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSafeHttpsUrl, formatError } from "./utils.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dir, "../proto/auth_service.proto");

function loadGrpcLibs() {
  const req = createRequire(import.meta.url);
  return {
    grpc: req("@grpc/grpc-js"),
    protoLoader: req("@grpc/proto-loader"),
  };
}

export class FinamGrpcJwtRenewal {
  constructor({
    grpcBase = "api.finam.ru:443",
    sdk = {},
    grpcLib = null,
    protoLoaderLib = null,
    protoPath = PROTO_PATH,
  } = {}) {
    this.grpcBase = normalizeGrpcTarget(grpcBase);
    this.sdk = sdk;
    this._grpcLib = grpcLib;
    this._protoLoaderLib = protoLoaderLib;
    this.protoPath = protoPath;
    this.client = null;
    this.stream = null;
  }

  get grpc() {
    if (!this._grpcLib) {
      const libs = loadGrpcLibs();
      this._grpcLib = libs.grpc;
      this._protoLoaderLib = libs.protoLoader;
    }
    return this._grpcLib;
  }

  get protoLoader() {
    if (!this._protoLoaderLib) {
      const libs = loadGrpcLibs();
      this._grpcLib = libs.grpc;
      this._protoLoaderLib = libs.protoLoader;
    }
    return this._protoLoaderLib;
  }

  start({ secret, onToken }) {
    if (this.stream) return false;

    this.client = this.createClient();
    this.stream = this.client.SubscribeJwtRenewal({ secret });
    this.stream.on("data", (message) => {
      if (message?.token) onToken(message.token);
    });
    this.stream.on("error", (err) => {
      this.sdk?.log?.warn?.(`Finam gRPC JWT renewal stream stopped: ${formatError(err)}`);
      this.closeClient();
    });
    this.stream.on("end", () => {
      this.closeClient();
    });
    return true;
  }

  stop() {
    this.stream?.cancel?.();
    this.closeClient();
  }

  closeClient() {
    this.stream = null;
    this.client?.close?.();
    this.client = null;
  }

  createClient() {
    const packageDefinition = this.protoLoader.loadSync(this.protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const loaded = this.grpc.loadPackageDefinition(packageDefinition);
    const AuthService = loaded?.grpc?.tradeapi?.v1?.auth?.AuthService;
    if (!AuthService) throw new Error("Finam gRPC AuthService definition was not loaded.");
    return new AuthService(this.grpcBase, this.grpc.credentials.createSsl());
  }
}

export function normalizeGrpcTarget(target) {
  const text = String(target ?? "").trim();
  if (!text) throw new Error("Finam gRPC base target is required.");

  const urlText = text.includes("://") ? text : `https://${text}`;
  assertSafeHttpsUrl(urlText);
  return stripGrpcAuthority(text);
}

function stripGrpcAuthority(target) {
  const schemeSeparatorIndex = target.indexOf("://");
  const startIndex = schemeSeparatorIndex === -1 ? 0 : schemeSeparatorIndex + 3;
  let endIndex = target.length;
  for (const separator of ["/", "?", "#"]) {
    const separatorIndex = target.indexOf(separator, startIndex);
    if (separatorIndex !== -1 && separatorIndex < endIndex) endIndex = separatorIndex;
  }
  return target.slice(startIndex, endIndex);
}
