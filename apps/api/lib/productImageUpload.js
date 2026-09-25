import sharp from "sharp";

function createThumbnail(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

export async function prepareProductImageUpload(inputBuffer) {
  try {
    let buffer = inputBuffer;
    let metadata = await sharp(buffer).metadata();
    let thumbnailBuffer;
    let normalized = false;

    try {
      thumbnailBuffer = await createThumbnail(buffer);
    } catch (error) {
      if (metadata.format !== "jpeg" || !/Invalid SOS parameters for sequential JPEG/.test(error.message)) {
        throw error;
      }

      // Some JPEG encoders emit invalid scan parameters that libjpeg can still
      // decode. Re-encode only this known warning, keeping errors/truncation fatal.
      // Store the repaired original too, so a later Local Line push can read it.
      buffer = await sharp(inputBuffer, { failOn: "error" })
        .rotate()
        .jpeg({ quality: 95 })
        .toBuffer();
      metadata = await sharp(buffer).metadata();
      thumbnailBuffer = await createThumbnail(buffer);
      normalized = true;
    }

    return { buffer, metadata, thumbnailBuffer, normalized };
  } catch (cause) {
    const error = new Error(
      "This image could not be processed. Please re-export it as JPEG or PNG and try again.",
      { cause }
    );
    error.status = 400;
    throw error;
  }
}
