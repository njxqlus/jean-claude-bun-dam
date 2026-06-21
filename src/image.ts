import { unlink } from "node:fs/promises";
import type { FocalPoint, ThumbnailRequest } from "./types";

type ImageMetadata = {
	width: number;
	height: number;
	format: string;
};

export async function extractImageMetadata(
	file: Blob,
): Promise<ImageMetadata | null> {
	const token = crypto.randomUUID();
	const inputPath = `/tmp/media-asset-${token}-identify-input.bin`;
	try {
		await Bun.write(inputPath, file);
		return await identifyImage(inputPath);
	} catch {
		return null;
	} finally {
		await unlink(inputPath).catch(() => undefined);
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function coverCropBox(
	sourceWidth: number,
	sourceHeight: number,
	targetWidth: number,
	targetHeight: number,
	focalPoint: FocalPoint | null,
) {
	const sourceAspect = sourceWidth / sourceHeight;
	const targetAspect = targetWidth / targetHeight;
	let cropWidth = sourceWidth;
	let cropHeight = sourceHeight;

	if (sourceAspect > targetAspect) {
		cropWidth = Math.round(sourceHeight * targetAspect);
	} else if (sourceAspect < targetAspect) {
		cropHeight = Math.round(sourceWidth / targetAspect);
	}

	const focus = focalPoint ?? { x: 0.5, y: 0.5 };
	const centerX = Math.round(focus.x * sourceWidth);
	const centerY = Math.round(focus.y * sourceHeight);
	const left = clamp(
		centerX - Math.round(cropWidth / 2),
		0,
		Math.max(0, sourceWidth - cropWidth),
	);
	const top = clamp(
		centerY - Math.round(cropHeight / 2),
		0,
		Math.max(0, sourceHeight - cropHeight),
	);

	return { left, top, cropWidth, cropHeight };
}

async function runCommand(command: string[]) {
	const proc = Bun.spawn(command, {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(stderr || "ImageMagick command failed");
	}
	return await new Response(proc.stdout).text();
}

async function identifyImage(path: string): Promise<ImageMetadata> {
	const stdout = await runCommand(["identify", "-format", "%w %h %m", path]);
	const [widthRaw, heightRaw, formatRaw] = stdout.trim().split(/\s+/, 3);
	const width = Number(widthRaw);
	const height = Number(heightRaw);
	if (!Number.isFinite(width) || !Number.isFinite(height) || !formatRaw) {
		throw new Error(`Unable to identify image: ${stdout}`);
	}
	return {
		width,
		height,
		format: formatRaw.toLowerCase(),
	};
}

async function runMagick(
	args: string[],
	input: Blob,
	extension: string,
): Promise<{ bytes: Uint8Array; metadata: ImageMetadata }> {
	const token = crypto.randomUUID();
	const inputPath = `/tmp/media-asset-${token}-input.bin`;
	const outputPath = `/tmp/media-asset-${token}-output.${extension}`;
	try {
		await Bun.write(inputPath, input);
		await runCommand(["convert", inputPath, ...args, outputPath]);
		return {
			bytes: new Uint8Array(await Bun.file(outputPath).arrayBuffer()),
			metadata: await identifyImage(outputPath),
		};
	} finally {
		await unlink(inputPath).catch(() => undefined);
		await unlink(outputPath).catch(() => undefined);
	}
}

export async function createDerivativeImage(
	input: Blob,
	request: ThumbnailRequest,
	sourceMetadata: ImageMetadata,
	focalPoint: FocalPoint | null,
) {
	const extension = request.format === "jpeg" ? "jpg" : request.format;
	const quality = String(request.quality ?? 82);

	if (request.fit === "inside") {
		const args = [
			"-resize",
			`${request.width}x${request.height}>`,
			...(request.format === "png" ? [] : ["-quality", quality]),
		];
		const result = await runMagick(args, input, extension);
		return {
			bytes: result.bytes,
			metadata: {
				width: result.metadata.width,
				height: result.metadata.height,
				format: request.format,
				fit: request.fit,
				focalPoint,
			},
			mimeType: `image/${request.format === "jpeg" ? "jpeg" : request.format}`,
		};
	}

	const crop = coverCropBox(
		sourceMetadata.width,
		sourceMetadata.height,
		request.width,
		request.height,
		focalPoint,
	);
	const args = [
		"-crop",
		`${crop.cropWidth}x${crop.cropHeight}+${crop.left}+${crop.top}`,
		"+repage",
		"-resize",
		`${request.width}x${request.height}!`,
		...(request.format === "png" ? [] : ["-quality", quality]),
	];
	const result = await runMagick(args, input, extension);
	return {
		bytes: result.bytes,
		metadata: {
			width: result.metadata.width,
			height: result.metadata.height,
			format: request.format,
			fit: request.fit,
			focalPoint,
		},
		mimeType: `image/${request.format === "jpeg" ? "jpeg" : request.format}`,
	};
}
