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
	try {
		const image = new Bun.Image(await file.arrayBuffer());
		const metadata = await image.metadata();
		return metadata;
	} catch {
		return null;
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

async function runMagick(
	args: string[],
	input: Blob,
	extension: string,
): Promise<Uint8Array> {
	const token = crypto.randomUUID();
	const inputPath = `/tmp/media-asset-${token}-input.bin`;
	const outputPath = `/tmp/media-asset-${token}-output.${extension}`;
	await Bun.write(inputPath, input);
	const command = ["convert", inputPath, ...args, outputPath];
	const proc = Bun.spawn(command, {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(stderr || "ImageMagick conversion failed");
	}
	const bytes = new Uint8Array(await Bun.file(outputPath).arrayBuffer());
	await unlink(inputPath).catch(() => undefined);
	await unlink(outputPath).catch(() => undefined);
	return bytes;
}

export async function createDerivativeImage(
	input: Blob,
	request: ThumbnailRequest,
	sourceMetadata: ImageMetadata,
	focalPoint: FocalPoint | null,
) {
	if (request.fit === "inside") {
		const image = new Bun.Image(await input.arrayBuffer()).resize(
			request.width,
			request.height,
			{ fit: "inside", withoutEnlargement: true },
		);
		if (request.format === "jpeg")
			image.jpeg({ quality: request.quality ?? 82 });
		if (request.format === "png") image.png();
		if (request.format === "webp")
			image.webp({ quality: request.quality ?? 82 });
		if (request.format === "avif")
			image.avif({ quality: request.quality ?? 82 });
		const bytes = await image.bytes();
		const metadata = await new Bun.Image(bytes).metadata();
		return {
			bytes,
			metadata: {
				width: metadata.width,
				height: metadata.height,
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
	const quality = String(request.quality ?? 82);
	const args = [
		"-crop",
		`${crop.cropWidth}x${crop.cropHeight}+${crop.left}+${crop.top}`,
		"+repage",
		"-resize",
		`${request.width}x${request.height}!`,
		...(request.format === "png" ? [] : ["-quality", quality]),
	];
	const bytes = await runMagick(
		args,
		input,
		request.format === "jpeg" ? "jpg" : request.format,
	);
	return {
		bytes,
		metadata: {
			width: request.width,
			height: request.height,
			format: request.format,
			fit: request.fit,
			focalPoint,
		},
		mimeType: `image/${request.format === "jpeg" ? "jpeg" : request.format}`,
	};
}
