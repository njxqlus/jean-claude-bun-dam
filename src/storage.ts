import { S3Client } from "bun";
import type { AppConfig } from "./config";

export type StoredObject = {
  key: string;
  size: number;
  contentType: string;
};

export interface StorageAdapter {
  readonly name: string;
  put(key: string, body: Blob, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null; size: number | null }>;
  delete(key: string): Promise<void>;
}

export class S3StorageAdapter implements StorageAdapter {
  readonly name = "s3";
  private readonly client: S3Client;

  constructor(config: AppConfig) {
    this.client = new S3Client({
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
      bucket: config.s3Bucket,
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      virtualHostedStyle: !config.s3PathStyle,
    });
  }

  async put(key: string, body: Blob, contentType: string): Promise<StoredObject> {
    await this.client.write(key, body, { type: contentType });
    return {
      key,
      size: body.size,
      contentType,
    };
  }

  async get(key: string) {
    const file = this.client.file(key);
    const exists = await file.exists();
    if (!exists) {
      throw new Error(`Object not found: ${key}`);
    }
    const type = file.type || null;
    return {
      body: file.stream(),
      contentType: type,
      size: Number.isFinite((file as Blob).size) ? (file as Blob).size : null,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(key);
  }
}
