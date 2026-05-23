import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { SessionEvent, SessionMeta } from './events'

interface UnwrapDB extends DBSchema {
  sessions: {
    key: string
    value: SessionMeta
    indexes: { 'by-createdAt': number }
  }
  events: {
    key: [string, number]
    value: SessionEvent & { seq: number }
    indexes: { 'by-session': string }
  }
  blobs: {
    key: string
    value: { ref: string; sessionId: string; mimeType: string; data: Blob }
    indexes: { 'by-session': string }
  }
}

let dbPromise: Promise<IDBPDatabase<UnwrapDB>> | null = null

export function db(): Promise<IDBPDatabase<UnwrapDB>> {
  if (!dbPromise) {
    dbPromise = openDB<UnwrapDB>('unwrap', 1, {
      upgrade(db) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' })
        sessions.createIndex('by-createdAt', 'createdAt')

        const events = db.createObjectStore('events', { keyPath: ['sessionId', 'seq'] })
        events.createIndex('by-session', 'sessionId')

        const blobs = db.createObjectStore('blobs', { keyPath: 'ref' })
        blobs.createIndex('by-session', 'sessionId')
      },
    })
  }
  return dbPromise
}

const seqCounters = new Map<string, number>()

function nextSeq(sessionId: string): number {
  const cur = seqCounters.get(sessionId) ?? 0
  const next = cur + 1
  seqCounters.set(sessionId, next)
  return next
}

export async function putSession(meta: SessionMeta): Promise<void> {
  const d = await db()
  await d.put('sessions', meta)
}

export async function getSession(id: string): Promise<SessionMeta | undefined> {
  const d = await db()
  return d.get('sessions', id)
}

export async function listSessions(): Promise<SessionMeta[]> {
  const d = await db()
  const all = await d.getAllFromIndex('sessions', 'by-createdAt')
  return all.reverse()
}

export async function deleteSession(id: string): Promise<void> {
  const d = await db()
  const tx = d.transaction(['sessions', 'events', 'blobs'], 'readwrite')
  await tx.objectStore('sessions').delete(id)

  const evIdx = tx.objectStore('events').index('by-session')
  for await (const cursor of evIdx.iterate(id)) {
    await cursor.delete()
  }
  const blobIdx = tx.objectStore('blobs').index('by-session')
  for await (const cursor of blobIdx.iterate(id)) {
    await cursor.delete()
  }
  await tx.done
  seqCounters.delete(id)
}

export async function appendEvent(event: SessionEvent): Promise<void> {
  const d = await db()
  const seq = nextSeq(event.sessionId)
  await d.put('events', { ...event, seq })
}

export async function listEvents(sessionId: string): Promise<(SessionEvent & { seq: number })[]> {
  const d = await db()
  const all = await d.getAllFromIndex('events', 'by-session', sessionId)
  return all.sort((a, b) => a.seq - b.seq)
}

export async function putBlob(ref: string, sessionId: string, mimeType: string, data: Blob): Promise<void> {
  const d = await db()
  await d.put('blobs', { ref, sessionId, mimeType, data })
}

export async function getBlob(ref: string): Promise<Blob | undefined> {
  const d = await db()
  const rec = await d.get('blobs', ref)
  return rec?.data
}

export async function listBlobs(sessionId: string): Promise<{ ref: string; mimeType: string; data: Blob }[]> {
  const d = await db()
  const all = await d.getAllFromIndex('blobs', 'by-session', sessionId)
  return all.map(({ ref, mimeType, data }) => ({ ref, mimeType, data }))
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
