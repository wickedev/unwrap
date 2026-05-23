import type { CrossSessionVisualDiff, CrossSessionVisualDiffPair, StoredSession } from '@unwrap/protocol'
import type { Env } from './env'
import { diffPng } from './pixeldiff'
import { getScreenshot, putScreenshot } from './storage/sessions'

// Cap pair count so the compare page doesn't blow the worker CPU budget
// on sessions with 20 screenshots each. Pairs are picked by closest
// relative timestamp, which usually surfaces the most informative
// states (page load, post-navigation settling, final view).
const MAX_PAIRS = 8
// Per-pair cache TTL on the diff PNGs in KV.
const TTL_SECONDS = 30 * 24 * 60 * 60

interface CrossDiffOwner {
  email: string
  ownerSessionId: string
}

export async function computeCrossSessionVisualDiff(
  env: Env,
  owner: CrossDiffOwner,
  baseline: StoredSession,
  current: StoredSession,
): Promise<CrossSessionVisualDiff> {
  const cacheKey = `cmp:${baseline.id}:${current.id}`

  // Cache hit shortcut — JSON metadata stored alongside the diff PNGs.
  if (env.SESSIONS) {
    const cached = await env.SESSIONS.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached) as CrossSessionVisualDiff
      } catch {
        // fall through and re-compute
      }
    }
  }

  const baselineShots = (baseline.verifyScreenshotMeta ?? []).slice().sort((a, b) => a.originalTs - b.originalTs)
  const currentShots = (current.verifyScreenshotMeta ?? []).slice().sort((a, b) => a.originalTs - b.originalTs)
  if (baselineShots.length === 0 || currentShots.length === 0) {
    return emptyResult(cacheKey)
  }

  const baseStart = baselineShots[0]!.originalTs
  const curStart = currentShots[0]!.originalTs

  // Pair by relative timestamp (each closest to its counterpart) without
  // re-using either side. Greedy is fine for ≤20 elements.
  const pairs: { a: typeof baselineShots[0]; b: typeof currentShots[0]; delta: number }[] = []
  const usedA = new Set<number>()
  const usedB = new Set<number>()
  for (let pi = 0; pi < MAX_PAIRS && pi < baselineShots.length && pi < currentShots.length; pi++) {
    let best: { i: number; j: number; delta: number } | null = null
    for (let i = 0; i < baselineShots.length; i++) {
      if (usedA.has(i)) continue
      const relA = baselineShots[i]!.originalTs - baseStart
      for (let j = 0; j < currentShots.length; j++) {
        if (usedB.has(j)) continue
        const relB = currentShots[j]!.originalTs - curStart
        const delta = Math.abs(relA - relB)
        if (best == null || delta < best.delta) best = { i, j, delta }
      }
    }
    if (!best) break
    usedA.add(best.i)
    usedB.add(best.j)
    pairs.push({ a: baselineShots[best.i]!, b: currentShots[best.j]!, delta: best.delta })
  }
  pairs.sort((x, y) => (x.a.originalTs - baseStart) - (y.a.originalTs - baseStart))

  const outPairs: CrossSessionVisualDiffPair[] = []
  const skipped: CrossSessionVisualDiff['skipped'] = []
  let totalDiffPx = 0
  let totalPx = 0

  for (let idx = 0; idx < pairs.length; idx++) {
    const { a, b, delta } = pairs[idx]!
    const [baseBytes, curBytes] = await Promise.all([
      getScreenshot(env, owner.email, baseline.id, a.storedRef),
      getScreenshot(env, owner.email, current.id, b.storedRef),
    ])
    if (!baseBytes || !curBytes) {
      skipped.push({
        baselineRef: a.storedRef,
        currentRef: b.storedRef,
        reason: !baseBytes ? 'baseline screenshot expired' : 'current screenshot expired',
      })
      continue
    }
    const result = diffPng({ originalBytes: baseBytes, replayBytes: curBytes })
    if (!result) {
      skipped.push({
        baselineRef: a.storedRef,
        currentRef: b.storedRef,
        reason: 'dimension mismatch or decode failure',
      })
      continue
    }

    const diffRef = `cmp-${baseline.id}-${current.id}-${idx}`
    await putScreenshot(env, owner.email, owner.ownerSessionId, diffRef, result.diffPng)

    totalDiffPx += result.diffPixels
    totalPx += result.totalPixels
    outPairs.push({
      baselineRef: a.storedRef,
      currentRef: b.storedRef,
      diffRef,
      width: result.width,
      height: result.height,
      diffPixels: result.diffPixels,
      totalPixels: result.totalPixels,
      diffRatio: result.totalPixels > 0 ? result.diffPixels / result.totalPixels : 0,
      baselineUrl: a.url,
      currentUrl: b.url,
      matchTimeDeltaMs: delta,
    })
  }

  const out: CrossSessionVisualDiff = {
    cacheKey,
    pairs: outPairs,
    skipped,
    totals: {
      diffPixels: totalDiffPx,
      totalPixels: totalPx,
      ratio: totalPx > 0 ? totalDiffPx / totalPx : 0,
    },
  }

  if (env.SESSIONS) {
    await env.SESSIONS.put(cacheKey, JSON.stringify(out), { expirationTtl: TTL_SECONDS })
  }
  return out
}

function emptyResult(cacheKey: string): CrossSessionVisualDiff {
  return {
    cacheKey,
    pairs: [],
    skipped: [],
    totals: { diffPixels: 0, totalPixels: 0, ratio: 0 },
  }
}
