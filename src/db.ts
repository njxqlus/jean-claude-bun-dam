import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SQL } from "bun";
import type { CreateAssetInput, CreateDerivativeInput, DerivativeRecord, JobRecord, JobType } from "./types";

export class Database {
  readonly sql: SQL;

  constructor(databaseUrl: string) {
    this.sql = new SQL(databaseUrl, {
      adapter: "postgres",
      max: 10,
      idleTimeout: 30,
    });
  }

  async connect(): Promise<void> {
    await this.sql.connect();
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  async migrate(migrationsDir: string): Promise<void> {
    await this.sql`
      create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `;
    const entries = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
    for (const entry of entries) {
      const [alreadyApplied] = await this.sql<{ version: string }[]>`
        select version from schema_migrations where version = ${entry}
      `;
      if (alreadyApplied) continue;
      const sqlText = await Bun.file(join(migrationsDir, entry)).text();
      await this.sql.begin(async (tx) => {
        await tx.unsafe(sqlText).simple();
        await tx`insert into schema_migrations ${tx({ version: entry })}`;
      });
    }
  }

  async insertAsset(input: CreateAssetInput) {
    const [asset] = await this.sql`
      insert into assets (
        id,
        original_filename,
        normalized_name,
        mime_type,
        size,
        checksum,
        storage_adapter,
        storage_key,
        kind,
        status,
        search_text,
        metadata,
        typed_metadata,
        expires_at,
        error
      ) values (
        ${input.id},
        ${input.originalFilename},
        ${input.normalizedName},
        ${input.mimeType},
        ${input.size},
        ${input.checksum},
        ${input.storageAdapter},
        ${input.storageKey},
        ${input.kind},
        ${input.status},
        ${input.searchText},
        ${JSON.stringify(input.metadata)}::jsonb,
        ${JSON.stringify(input.typedMetadata)}::jsonb,
        ${input.expiresAt},
        ${input.error}
      )
      returning *
    `;
    return asset;
  }

  async updateAssetStatus(assetId: string, status: string, error: string | null) {
    const [asset] = await this.sql`
      update assets
      set status = ${status},
          error = ${error},
          updated_at = now()
      where id = ${assetId}
      returning *
    `;
    return asset ?? null;
  }

  async getAssetById(assetId: string) {
    const [asset] = await this.sql`select * from assets where id = ${assetId}`;
    if (!asset) return null;
    const derivatives = await this.sql`select * from asset_derivatives where asset_id = ${assetId} order by created_at asc`;
    return { ...asset, derivatives };
  }

  async insertDerivative(input: CreateDerivativeInput) {
    const [record] = await this.sql`
      insert into asset_derivatives (
        id,
        asset_id,
        name,
        storage_adapter,
        storage_key,
        mime_type,
        size,
        metadata
      ) values (
        ${crypto.randomUUID()},
        ${input.assetId},
        ${input.name},
        ${input.storageAdapter},
        ${input.storageKey},
        ${input.mimeType},
        ${input.size},
        ${JSON.stringify(input.metadata)}::jsonb
      )
      on conflict (asset_id, name)
      do update set
        storage_adapter = excluded.storage_adapter,
        storage_key = excluded.storage_key,
        mime_type = excluded.mime_type,
        size = excluded.size,
        metadata = excluded.metadata,
        created_at = now()
      returning *
    `;
    return record;
  }

  async getDerivative(assetId: string, name: string): Promise<DerivativeRecord | null> {
    const [row] = await this.sql<DerivativeRecord[]>`
      select * from asset_derivatives where asset_id = ${assetId} and name = ${name}
    `;
    return row ?? null;
  }

  async deleteAsset(assetId: string) {
    return await this.sql.begin(async (tx) => {
      await tx`delete from jobs where payload->>'assetId' = ${assetId}`;
      const derivatives = await tx`select * from asset_derivatives where asset_id = ${assetId}`;
      const [asset] = await tx`delete from assets where id = ${assetId} returning *`;
      return { asset: asset ?? null, derivatives };
    });
  }

  async listAssets(filters: {
    limit: number;
    offset: number;
    sortBy: string;
    sortDirection: "asc" | "desc";
    kind: string | null;
    mimeType: string | null;
    status: string | null;
    search: string | null;
    createdAtFrom: string | null;
    createdAtTo: string | null;
    expiresAtFrom: string | null;
    expiresAtTo: string | null;
    metadata: Record<string, unknown> | null;
    typedMetadata: Record<string, unknown> | null;
  }) {
    const allowedSorts = new Set(["created_at", "expires_at", "mime_type", "kind", "status", "size"]);
    const sortBy = allowedSorts.has(filters.sortBy) ? filters.sortBy : "created_at";
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value?: unknown) => {
      clauses.push(sql.replace("?", `$${values.length + 1}`));
      if (value !== undefined) values.push(value);
    };

    if (filters.kind) add(`kind = ?`, filters.kind);
    if (filters.mimeType) add(`mime_type = ?`, filters.mimeType);
    if (filters.status) add(`status = ?`, filters.status);
    if (filters.search) {
      const value = `%${filters.search.toLowerCase()}%`;
      clauses.push(`(lower(coalesce(search_text, '')) like $${values.length + 1} or lower(original_filename) like $${values.length + 1} or lower(normalized_name) like $${values.length + 1})`);
      values.push(value);
    }
    if (filters.createdAtFrom) add(`created_at >= ?`, filters.createdAtFrom);
    if (filters.createdAtTo) add(`created_at <= ?`, filters.createdAtTo);
    if (filters.expiresAtFrom) add(`expires_at is not null and expires_at >= ?`, filters.expiresAtFrom);
    if (filters.expiresAtTo) add(`expires_at is not null and expires_at <= ?`, filters.expiresAtTo);
    if (filters.metadata) add(`metadata @> ?::jsonb`, JSON.stringify(filters.metadata));
    if (filters.typedMetadata) add(`typed_metadata @> ?::jsonb`, JSON.stringify(filters.typedMetadata));

    const whereClause = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const countQuery = `select count(*)::int as total from assets ${whereClause}`;
    const rowsQuery = `
      select *
      from assets
      ${whereClause}
      order by ${sortBy} ${filters.sortDirection}
      limit $${values.length + 1}
      offset $${values.length + 2}
    `;
    const queryValues = [...values, filters.limit, filters.offset];
    const [countRow] = await this.sql.unsafe<{ total: number }[]>(countQuery, values);
    const rows = await this.sql.unsafe<any[]>(rowsQuery, queryValues);
    const assetIds = rows.map((row) => row.id);
    const derivatives =
      assetIds.length > 0
        ? await this.sql<any[]>`
            select *
            from asset_derivatives
            where asset_id = any(${this.sql.array(assetIds, "UUID")})
            order by created_at asc
          `
        : [];
    const derivativesByAsset = new Map<string, any[]>();
    for (const derivative of derivatives) {
      const existing = derivativesByAsset.get(derivative.asset_id) ?? [];
      existing.push(derivative);
      derivativesByAsset.set(derivative.asset_id, existing);
    }
    return {
      total: countRow?.total ?? 0,
      rows: rows.map((row) => ({ ...row, derivatives: derivativesByAsset.get(row.id) ?? [] })),
    };
  }

  async enqueueJob(type: JobType, payload: Record<string, unknown>, options?: { maxAttempts?: number; runAfter?: string }) {
    const [job] = await this.sql`
      insert into jobs (
        id,
        type,
        status,
        payload,
        attempts,
        max_attempts,
        run_after,
        locked_at,
        locked_by,
        error
      ) values (
        ${crypto.randomUUID()},
        ${type},
        'pending',
        ${JSON.stringify(payload)}::jsonb,
        0,
        ${options?.maxAttempts ?? 5},
        ${options?.runAfter ?? new Date().toISOString()},
        null,
        null,
        null
      )
      returning *
    `;
    return job;
  }

  async claimNextJob(workerId: string): Promise<JobRecord | null> {
    return await this.sql.begin(async (tx) => {
      const [job] = await tx<JobRecord[]>`
        select *
        from jobs
        where status in ('pending', 'failed')
          and attempts < max_attempts
          and run_after <= now()
          and (locked_at is null or locked_at < now() - interval '5 minutes')
        order by run_after asc, created_at asc
        for update skip locked
        limit 1
      `;
      if (!job) return null;
      const [claimed] = await tx<JobRecord[]>`
        update jobs
        set status = 'running',
            attempts = attempts + 1,
            locked_at = now(),
            locked_by = ${workerId},
            updated_at = now(),
            error = null
        where id = ${job.id}
        returning *
      `;
      return claimed ?? null;
    });
  }

  async completeJob(jobId: string) {
    await this.sql`
      update jobs
      set status = 'completed',
          locked_at = null,
          locked_by = null,
          updated_at = now()
      where id = ${jobId}
    `;
  }

  async failJob(jobId: string, error: string, runAfter: string | null) {
    await this.sql`
      update jobs
      set status = 'failed',
          error = ${error},
          locked_at = null,
          locked_by = null,
          run_after = ${runAfter ?? new Date().toISOString()},
          updated_at = now()
      where id = ${jobId}
    `;
  }

  async countPendingThumbnailJobs(assetId: string): Promise<number> {
    const [row] = await this.sql<{ total: number }[]>`
      select count(*)::int as total
      from jobs
      where type = 'thumbnail.generate'
        and status in ('pending', 'running', 'failed')
        and attempts < max_attempts
        and payload->>'assetId' = ${assetId}
    `;
    return row?.total ?? 0;
  }

  async listExpiredAssetRows(limit = 100) {
    return await this.sql`
      select *
      from assets
      where expires_at is not null and expires_at <= now()
      order by expires_at asc
      limit ${limit}
    `;
  }
}
