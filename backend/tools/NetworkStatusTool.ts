/**
 * backend/tools/NetworkStatusTool.ts
 *
 * Checks health and latency for both Horizon and Soroban RPC endpoints.
 */

import axios from "axios";
import { rpc } from "@stellar/stellar-sdk";
import { config } from "../config";
import { logger } from "../logger";
import { sorobanServer as defaultSorobanServer } from "../rpc_client";

export interface ServiceHealth {
  healthy: boolean;
  latencyMs: number;
  status?: string | undefined;
  error?: string | undefined;
}

export interface NetworkStatusResult {
  horizon: ServiceHealth;
  soroban: ServiceHealth;
  network: string;
}

export class NetworkStatusTool {
  private horizonUrl: string;
  private sorobanServer: rpc.Server;
  private network: string;

  constructor(
    horizonUrl: string = config.HORIZON_URL,
    sorobanServer: rpc.Server = defaultSorobanServer,
    network: string = config.STELLAR_NETWORK
  ) {
    this.horizonUrl = horizonUrl;
    this.sorobanServer = sorobanServer;
    this.network = network;
  }

  async execute(): Promise<NetworkStatusResult> {
    // 1. Check Horizon endpoint health & latency
    const horizonStart = Date.now();
    let horizonHealth: ServiceHealth;

    try {
      const res = await axios.get(this.horizonUrl, { timeout: 10_000 });
      const latencyMs = Date.now() - horizonStart;
      const healthy = res.status >= 200 && res.status < 400;
      horizonHealth = {
        healthy,
        latencyMs,
        status: res.statusText || (healthy ? "healthy" : "unhealthy"),
      };
    } catch (err) {
      horizonHealth = {
        healthy: false,
        latencyMs: Date.now() - horizonStart,
        error: (err as Error).message,
      };
    }

    // 2. Check Soroban RPC health & latency
    const sorobanStart = Date.now();
    let sorobanHealth: ServiceHealth;

    try {
      const health = await this.sorobanServer.getHealth();
      const latencyMs = Date.now() - sorobanStart;
      const status = typeof health?.status === "string" ? health.status : "healthy";
      const healthy = status === "healthy" || status === "pass";
      sorobanHealth = {
        healthy,
        latencyMs,
        status,
      };
    } catch (err) {
      sorobanHealth = {
        healthy: false,
        latencyMs: Date.now() - sorobanStart,
        error: (err as Error).message,
      };
    }

    logger.info("Network status queried", {
      horizonHealthy: horizonHealth.healthy,
      horizonLatencyMs: horizonHealth.latencyMs,
      sorobanHealthy: sorobanHealth.healthy,
      sorobanLatencyMs: sorobanHealth.latencyMs,
      network: this.network,
    });

    return {
      horizon: horizonHealth,
      soroban: sorobanHealth,
      network: this.network,
    };
  }
}
