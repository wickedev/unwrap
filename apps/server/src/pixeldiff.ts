import pixelmatch from 'pixelmatch'
import UPNG from 'upng-js'

const DIFF_THRESHOLD = 0.1 // pixelmatch sensitivity; smaller = stricter

interface DecodedPng {
  width: number
  height: number
  rgba: Uint8Array
}

export interface DiffOutcome {
  width: number
  height: number
  diffPixels: number
  totalPixels: number
  diffPng: ArrayBuffer
}

export function diffPng(args: {
  originalBytes: ArrayBuffer
  replayBytes: ArrayBuffer
}): DiffOutcome | null {
  let original: DecodedPng
  let replay: DecodedPng
  try {
    original = decodePng(args.originalBytes)
    replay = decodePng(args.replayBytes)
  } catch {
    return null
  }
  if (original.width !== replay.width || original.height !== replay.height) {
    return null
  }
  const { width, height } = original
  const out = new Uint8Array(width * height * 4)
  const diffPixels = pixelmatch(original.rgba, replay.rgba, out, width, height, {
    threshold: DIFF_THRESHOLD,
    includeAA: false,
    alpha: 0.4,
  })
  return {
    width,
    height,
    diffPixels,
    totalPixels: width * height,
    diffPng: encodePng(out, width, height),
  }
}

function decodePng(buf: ArrayBuffer): DecodedPng {
  const img = UPNG.decode(buf)
  const frames = UPNG.toRGBA8(img) as ArrayBuffer[]
  const first = frames[0]
  if (!first) throw new Error('PNG has no frames')
  return {
    width: img.width,
    height: img.height,
    rgba: new Uint8Array(first),
  }
}

function encodePng(rgba: Uint8Array, width: number, height: number): ArrayBuffer {
  return UPNG.encode([rgba.buffer as ArrayBuffer], width, height, 0)
}
