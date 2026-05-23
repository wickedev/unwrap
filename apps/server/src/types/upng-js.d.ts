declare module 'upng-js' {
  interface DecodedImage {
    width: number
    height: number
    depth: number
    ctype: number
    frames: unknown[]
    tabs: unknown
    data: Uint8Array
  }
  export function decode(buffer: ArrayBuffer | Uint8Array): DecodedImage
  // Returns one ArrayBuffer (RGBA8) per frame.
  export function toRGBA8(img: DecodedImage): ArrayBuffer[]
  // cnum: 0 = lossless truecolor + alpha; otherwise palette size cap.
  export function encode(
    rgbaFrames: ArrayBuffer[],
    width: number,
    height: number,
    cnum: number,
    delays?: number[],
  ): ArrayBuffer
  const UPNG: {
    decode: typeof decode
    toRGBA8: typeof toRGBA8
    encode: typeof encode
  }
  export default UPNG
}
