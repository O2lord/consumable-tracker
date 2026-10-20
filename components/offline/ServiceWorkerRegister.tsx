"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (public/sw.js). Production only: in development a worker that caches
 * scripts makes every code change look like it did not work.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // The app works without it; only offline reloads are lost.
    });
  }, []);
  return null;
}
