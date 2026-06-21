import type { AssetService } from "./service";
import type { JobRecord, ThumbnailJobPayload } from "./types";

export class JobWorker {
	private running = false;
	private timer: Timer | null = null;

	constructor(
		private readonly service: AssetService,
		private readonly workerId: string,
		private readonly intervalMs: number,
	) {}

	start() {
		if (this.running) return;
		this.running = true;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
		void this.tick();
	}

	stop() {
		this.running = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private async tick() {
		if (!this.running) return;
		const job = await this.service.db.claimNextJob(this.workerId);
		if (!job) return;
		await this.execute(job);
	}

	private async execute(job: JobRecord) {
		try {
			if (job.type === "thumbnail.generate") {
				const assetId = await this.service.processThumbnailJob(
					job.payload as ThumbnailJobPayload,
				);
				await this.service.db.completeJob(job.id);
				const pending =
					await this.service.db.countPendingThumbnailJobs(assetId);
				if (pending === 0) {
					await this.service.db.updateAssetStatus(assetId, "ready", null);
				}
			} else if (job.type === "cleanup.expired") {
				await this.service.cleanupExpired();
				await this.service.db.completeJob(job.id);
			} else {
				throw new Error(`Unsupported job type: ${job.type}`);
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown job error";
			if (job.type === "thumbnail.generate") {
				const payload = job.payload as ThumbnailJobPayload;
				await this.service.db.updateAssetStatus(
					payload.assetId,
					"failed",
					message,
				);
			}
			const runAfter = new Date(
				Date.now() + Math.min(job.attempts, 10) * 5000,
			).toISOString();
			await this.service.db.failJob(job.id, message, runAfter);
		}
	}
}
