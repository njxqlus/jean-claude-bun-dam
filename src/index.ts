import { join } from "node:path";
import { loadConfig } from "./config";
import { Database } from "./db";
import { AssetService } from "./service";
import { JobWorker } from "./worker";
import { errorResponse, jsonResponse } from "./utils";

const config = loadConfig();
const db = new Database(config.databaseUrl);
await db.connect();
await db.migrate(join(import.meta.dir, "migrations"));
const service = new AssetService(config, db);
const worker = new JobWorker(service, config.workerId, config.workerPollIntervalMs);
worker.start();

setInterval(() => {
  void db.enqueueJob("cleanup.expired", {}, { maxAttempts: 1 });
}, config.cleanupIntervalSeconds * 1000);

function routeMatch(pathname: string, pattern: RegExp) {
  return pathname.match(pattern);
}

const server = Bun.serve({
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/assets") {
        const asset = await service.createAssetFromRequest(request);
        return jsonResponse(asset, 201);
      }
      if (request.method === "GET" && url.pathname === "/assets") {
        return jsonResponse(await service.listAssets(url));
      }

      const assetMatch = routeMatch(url.pathname, /^\/assets\/([^/]+)$/);
      if (request.method === "GET" && assetMatch) {
        const asset = await service.getAsset(assetMatch[1]!);
        return asset ? jsonResponse(asset) : errorResponse(404, "Asset not found");
      }
      if (request.method === "DELETE" && assetMatch) {
        const deleted = await service.deleteAsset(assetMatch[1]!);
        return deleted ? jsonResponse(deleted) : errorResponse(404, "Asset not found");
      }

      const assetFileMatch = routeMatch(url.pathname, /^\/assets\/([^/]+)\/file$/);
      if (request.method === "GET" && assetFileMatch) {
        const response = await service.getOriginalFileResponse(assetFileMatch[1]!);
        return response ?? errorResponse(404, "Asset not found");
      }

      const derivativeMatch = routeMatch(url.pathname, /^\/assets\/([^/]+)\/derivatives\/([^/]+)$/);
      if (request.method === "GET" && derivativeMatch) {
        const response = await service.getDerivativeFileResponse(derivativeMatch[1]!, derivativeMatch[2]!);
        return response ?? errorResponse(404, "Derivative not found");
      }

      if (request.method === "POST" && url.pathname === "/internal/cleanup-expired") {
        return jsonResponse(await service.cleanupExpired());
      }

      return errorResponse(404, "Route not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      return errorResponse(400, message);
    }
  },
  error(error) {
    return errorResponse(500, error.message);
  },
});

console.log(`media asset service listening on http://localhost:${server.port}`);
