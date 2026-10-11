export interface ImageHeader {
  format: "png" | "jpeg";
  width: number;
  height: number;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const JPEG_SCAN_LIMIT = 1024 * 1024;

export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (
    bytes.byteLength >= 24 &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value) &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      format: "png",
      width: view.getUint32(16, false),
      height: view.getUint32(20, false),
    };
  }

  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const end = Math.min(bytes.byteLength, JPEG_SCAN_LIMIT);
  let offset = 2;

  while (offset < end) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < end && bytes[offset] === 0xff) offset++;
    if (offset >= end) return null;
    const marker = bytes[offset++]!;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > end) return null;

    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > end) return null;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (segmentLength < 7) return null;
      return {
        format: "jpeg",
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    offset += segmentLength;
  }

  return null;
}
