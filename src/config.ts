export type AppConfig = {
  appEnv: string;
  port: number;
  databaseUrl: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3PathStyle: boolean;
  s3Prefix: string;
  maxUploadBytes: number;
  cleanupIntervalSeconds: number;
  workerPollIntervalMs: number;
  workerId: string;
};

function required(name: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }
  return parsed;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function loadConfig(): AppConfig {
  return {
    appEnv: Bun.env.APP_ENV ?? "development",
    port: numberEnv("PORT", 3000),
    databaseUrl: required("DATABASE_URL"),
    s3Endpoint: required("S3_ENDPOINT"),
    s3Region: Bun.env.S3_REGION ?? "us-east-1",
    s3Bucket: required("S3_BUCKET"),
    s3AccessKeyId: required("S3_ACCESS_KEY_ID"),
    s3SecretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    s3PathStyle: booleanEnv("S3_PATH_STYLE", true),
    s3Prefix: Bun.env.S3_PREFIX ?? "assets",
    maxUploadBytes: numberEnv("MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
    cleanupIntervalSeconds: numberEnv("CLEANUP_INTERVAL_SECONDS", 300),
    workerPollIntervalMs: numberEnv("WORKER_POLL_INTERVAL_MS", 2000),
    workerId: Bun.env.WORKER_ID ?? `worker-${crypto.randomUUID()}`,
  };
}
