import pixelmatch from 'pixelmatch'
// upng-js exposes both `default` and named members depending on bundler; we
// only use decode/encode so destructure from the default export.
import UPNG from 'upng-js'
import type { VisualDiff } from '@unwrap/protocol'
import type { Env } from './env'
import { putScreenshot } from './storage/sessions'

const DIFF_THRESHOLD = 0.1 // pixelmatch sensitivity; smaller = stricter

interface DecodedPng {
  width: number
  height: number
  rgba: Uint8Array
}

export async function diffEndState(args: {
  env: Env
  email: string
  sessionId: string
  originalRef: string
  originalBytes: ArrayBuffer
  replayRef: string
  replayBytes: ArrayBuffer
}): Promise<{ diff?: VisualDiff; message?: string }> {
  let original: DecodedPng
  let replay: DecodedPng
  try {
    original = decodePng(args.originalBytes)
  } catch (e) {
    return { message: `failed to decode original screenshot: ${asMessage(e)}` }
  }
  try {
    replay = decodePng(args.replayBytes)
  } catch (e) {
    return { message: `failed to decode replay screenshot: ${asMessage(e)}` }
  }

  if (original.width !== replay.width || original.height !== replay.height) {
    return {
      message: `dimension mismatch — captured ${original.width}×${original.height}, replay ${replay.width}×${replay.height}`,
    }
  }

  const { width, height } = original
  const diffBuffer = new Uint8Array(width * height * 4)
  const diffPixels = pixelmatch(original.rgba, replay.rgba, diffBuffer, width, height, {
    threshold: DIFF_THRESHOLD,
    includeAA: false,
    alpha: 0.4,
  })

  const diffPng = encodePng(diffBuffer, width, height)
  const diffRef = `verify-${args.sessionId}-diff`
  await putScreenshot(args.env, args.email, args.sessionId, diffRef, diffPng)

  const totalPixels = width * height
  return {
    diff: {
      position: 'final',
      originalRef: args.originalRef,
      replayRef: args.replayRef,
      diffRef,
      width,
      height,
      diffPixels,
      totalPixels,
      diffRatio: totalPixels > 0 ? diffPixels / totalPixels : 0,
    },
  }
}

function decodePng(buf: ArrayBuffer): DecodedPng {
  const img = UPNG.decode(buf)
  // UPNG.toRGBA8 returns an array of frames; static PNG = first frame.
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
  // Lossless — second arg is the palette (0 = truecolor + alpha).
  return UPNG.encode([rgba.buffer as ArrayBuffer], width, height, 0)
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
