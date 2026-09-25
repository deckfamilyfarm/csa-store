import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { prepareProductImageUpload } from "./productImageUpload.js";

async function createJpeg() {
  return sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#b26644" } })
    .jpeg({ progressive: false })
    .toBuffer();
}

function withInvalidScanParameter(jpeg, offsetFromEnd, value) {
  const input = Buffer.from(jpeg);
  const marker = input.indexOf(Buffer.from([0xff, 0xda]));
  assert.ok(marker > 0, "JPEG must have a Start of Scan marker");
  const length = input.readUInt16BE(marker + 2);
  input[marker + 2 + length - offsetFromEnd] = value;
  return input;
}

for (const [parameter, offsetFromEnd, value] of [["Ss", 3, 1], ["Se", 2, 2], ["Ah/Al", 1, 16]]) {
  test(`repairs the reported sequential JPEG warning for invalid ${parameter}`, async () => {
    const input = withInvalidScanParameter(await createJpeg(), offsetFromEnd, value);
    await assert.rejects(
      sharp(input).resize({ width: 1200, height: 1200, fit: "inside" }).jpeg().toBuffer(),
      /Invalid SOS parameters for sequential JPEG/
    );

    const result = await prepareProductImageUpload(input);
    assert.equal(result.normalized, true);
    assert.notDeepEqual(result.buffer, input);
    assert.equal(result.metadata.format, "jpeg");
    assert.equal(result.metadata.width, 1600);
    assert.equal(result.metadata.height, 1200);
    // Strict decoding of both stored files succeeds, including a later resize
    // such as the one Local Line might perform on the original image.
    await sharp(result.buffer).resize(800).jpeg().toBuffer();
    const thumbnail = await sharp(result.thumbnailBuffer).metadata();
    assert.equal(thumbnail.width, 1200);
    assert.equal(thumbnail.height, 900);
    const stats = await sharp(result.thumbnailBuffer).stats();
    for (const [index, expected] of [178, 102, 68].entries()) {
      assert.ok(Math.abs(stats.channels[index].mean - expected) < 4, "Image colours must survive recovery");
    }
  });
}

test("healthy JPEG originals are preserved", async () => {
  const input = await createJpeg();
  const result = await prepareProductImageUpload(input);
  assert.equal(result.normalized, false);
  assert.deepEqual(result.buffer, input);
  assert.equal((await sharp(result.thumbnailBuffer).metadata()).format, "jpeg");
});

test("transparent PNG originals are preserved and small thumbnails are not enlarged", async () => {
  const input = await sharp({ create: { width: 64, height: 32, channels: 4, background: "#b2664480" } }).png().toBuffer();
  const result = await prepareProductImageUpload(input);
  assert.equal(result.normalized, false);
  assert.deepEqual(result.buffer, input);
  assert.equal(result.metadata.hasAlpha, true);
  const thumbnail = await sharp(result.thumbnailBuffer).metadata();
  assert.equal(thumbnail.width, 64);
  assert.equal(thumbnail.height, 32);
});

test("phone photo orientation is applied to the thumbnail", async () => {
  const input = await sharp(await createJpeg()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await prepareProductImageUpload(input);
  assert.deepEqual(result.buffer, input);
  const thumbnail = await sharp(result.thumbnailBuffer).metadata();
  assert.equal(thumbnail.width, 900);
  assert.equal(thumbnail.height, 1200);
});

for (const invalidScan of [false, true]) {
  test(`rejects truncated JPEG pixel data${invalidScan ? " even when the scan warning is present" : ""}`, async () => {
    const jpeg = await createJpeg();
    const input = invalidScan ? withInvalidScanParameter(jpeg, 3, 1) : jpeg;
    await assert.rejects(prepareProductImageUpload(input.subarray(0, Math.floor(input.length / 2))), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /re-export it as JPEG or PNG/);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  });
}

test("invalid file data returns an actionable upload error", async () => {
  await assert.rejects(prepareProductImageUpload(Buffer.from("not an image")), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /re-export it as JPEG or PNG/);
    return true;
  });
});
