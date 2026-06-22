import { join } from "node:path";
import { loadConfig } from "./config";
import { Database } from "./db";

const config = loadConfig();
const db = new Database(config.databaseUrl);
await db.connect();
await db.migrate(join(import.meta.dir, "migrations"));
await db.close();
console.log("migrations applied");
