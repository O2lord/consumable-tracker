"use client";

import { useSyncExternalStore } from "react";
import { getServerSnapshot, getSyncSnapshot, subscribeSync, type SyncState } from "./sync";

/** The live state of the offline queue: online or not, what is waiting, what needs attention. */
export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncSnapshot, getServerSnapshot);
}
