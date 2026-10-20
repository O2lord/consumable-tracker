// The on-device queue of scans, in IndexedDB so it survives a reload, a closed tab and a dead battery
// on the router. Browser-only. Every write tells the rest of the page via QUEUE_CHANGED.

import type { QueuedEvent } from "./sync-core";

const DB_NAME = "consumables-offline";
const STORE = "events";
const VERSION = 1;

export const QUEUE_CHANGED = "ct-queue-changed";

export function isQueueSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

let opened: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opened = null;
      reject(request.error ?? new Error("Could not open the offline queue"));
    };
  });
  return opened;
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = work(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? new Error("Offline queue write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Offline queue write aborted"));
  });
}

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(QUEUE_CHANGED));
}

/** Oldest scan first. */
export async function listEvents(): Promise<QueuedEvent[]> {
  const all = await run<QueuedEvent[]>("readonly", (store) => store.getAll());
  return all.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

/** Adds or replaces one event (the id is the key, so saving twice cannot duplicate it). */
export async function putEvent(event: QueuedEvent): Promise<void> {
  await run("readwrite", (store) => store.put(event));
  notify();
}

export async function removeEvents(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const id of ids) store.delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Offline queue delete failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Offline queue delete aborted"));
  });
  notify();
}
