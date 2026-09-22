import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('brand assets', () => {
  it('embeds 8-bit RGBA PNGs in the favicon so Turbopack can decode every size', () => {
    const icon = readFileSync(new URL('../src/app/favicon.ico', import.meta.url));
    const expectedSizes = [16, 32, 48];
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    expect(icon.length).toBeGreaterThanOrEqual(6);
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    const count = icon.readUInt16LE(4);
    expect(count).toBe(expectedSizes.length);
    const directoryEnd = 6 + count * 16;
    expect(icon.length).toBeGreaterThanOrEqual(directoryEnd);

    let previousEnd = directoryEnd;
    for (const [index, size] of expectedSizes.entries()) {
      const entry = 6 + index * 16;
      const width = icon[entry] || 256;
      const height = icon[entry + 1] || 256;
      expect([width, height]).toEqual([size, size]);
      expect(icon.readUInt16LE(entry + 4)).toBe(1);
      expect(icon.readUInt16LE(entry + 6)).toBe(32);

      const length = icon.readUInt32LE(entry + 8);
      const offset = icon.readUInt32LE(entry + 12);
      expect(offset).toBeGreaterThanOrEqual(previousEnd);
      expect(length).toBeGreaterThanOrEqual(33);
      expect(offset + length).toBeLessThanOrEqual(icon.length);
      const png = icon.subarray(offset, offset + length);
      expect(png.subarray(0, 8)).toEqual(pngSignature);
      expect(png.readUInt32BE(8)).toBe(13);
      expect(png.toString('ascii', 12, 16)).toBe('IHDR');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height]);
      expect(png[24]).toBe(8);
      expect(png[25], `${size}px favicon must use RGBA PNG color type 6`).toBe(6);
      previousEnd = offset + length;
    }
  });
});
