import { join } from "node:path";
import { createServer } from "./app";
import { loadConfig } from "./config";
import { Database } from "./db";
import { AssetService } from "./service";
import { JobWorker } from "./worker";

const config = loadConfig();
const db = new Database(config.databaseUrl);
await db.connect();
await db.migrate(join(import.meta.dir, "migrations"));
const service = new AssetService(config, db);
const worker = new JobWorker(
	service,
	config.workerId,
	config.workerPollIntervalMs,
);
worker.start();

setInterval(() => {
	void db.enqueueJob("cleanup.expired", {}, { maxAttempts: 1 });
}, config.cleanupIntervalSeconds * 1000);
const server = createServer(service, config.port);

console.log(`media asset service listening on http://localhost:${server.port}`);
