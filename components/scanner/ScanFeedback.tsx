"use client";

import { useEffect, useRef } from "react";

/** `queued`: saved on this device but not yet confirmed by the server (offline scanning). */
export type ScanOutcomeKind = "ok" | "duplicate" | "error" | "queued";

export interface ScanOutcome {
  kind: ScanOutcomeKind;
  message: string;
}

const STYLE: Record<ScanOutcomeKind, string> = {
  ok: "border-ok bg-ok-soft text-ok",
  duplicate: "border-warn bg-warn-soft text-warn",
  error: "border-bad bg-bad-soft text-bad",
  queued: "border-brand bg-brand-soft text-brand",
};

// Short tones so a scan can be judged without looking at the screen: high = good,
// middle = already scanned, low and long = rejected.
const TONES: Record<ScanOutcomeKind, { freq: number; ms: number }> = {
  ok: { freq: 1200, ms: 80 },
  duplicate: { freq: 700, ms: 160 },
  error: { freq: 220, ms: 380 },
  queued: { freq: 900, ms: 120 },
};

function beep(kind: ScanOutcomeKind, ctxRef: { current: AudioContext | null }) {
  try {
    const Ctx = window.AudioContext;
    if (!Ctx) return;
    const ctx = (ctxRef.current ??= new Ctx());
    const { freq, ms } = TONES[kind];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
  } catch {
    // Sound is a nicety. A browser that blocks audio must never break scanning.
  }
}

const sharedCtx: { current: AudioContext | null } = { current: null };

/** Plays the same tone as the scan banner, for a result shown some other way (a pop-up, a toast). */
export function playScanTone(kind: ScanOutcomeKind) {
  beep(kind, sharedCtx);
}

/** Large success / already-scanned / error banner for fast, eyes-off scanning. */
export function ScanFeedback({ outcome, nonce }: { outcome: ScanOutcome | null; nonce: number }) {
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (outcome) beep(outcome.kind, ctxRef);
    // `nonce` changes on every scan, so repeating the same result still beeps.
  }, [outcome, nonce]);

  if (!outcome) {
    return <div className="min-h-14 rounded-xl border border-dashed border-line bg-page px-3 py-3 text-sm text-muted">Waiting for a scan</div>;
  }
  return (
    <div
      role={outcome.kind === "error" ? "alert" : "status"}
      className={`min-h-14 rounded-xl border-2 px-3 py-3 text-base font-semibold ${STYLE[outcome.kind]}`}
    >
      {outcome.message}
    </div>
  );
}
