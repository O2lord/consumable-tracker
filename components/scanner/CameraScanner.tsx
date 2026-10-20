"use client";

import { useEffect, useRef, useState } from "react";
import { ghostButtonClass } from "@/components/ui/styles";
import { createDetector } from "./cameraDecoder";

/** How often a frame is checked. Fast enough to feel instant, slow enough to spare the battery. */
const SCAN_INTERVAL_MS = 120;
/**
 * A code that stays in view is one scan, not many. The same code only counts again after it has been
 * out of view for this long, so scanning the same bottle twice on purpose means moving the camera away
 * and back.
 */
const REARM_MS = 800;

interface Props {
  /** Called once per code read. */
  onCode: (value: string) => void;
  /** True while the previous scan is being processed; new codes wait until it is false. */
  paused: boolean;
  onClose: () => void;
}

function describeError(err: unknown): string {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "The camera only works on a secure (https) page.";
  }
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") {
    return "Camera access is blocked. Allow the camera for this site in the browser settings, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device.";
  if (name === "NotReadableError") return "The camera is being used by another app.";
  return "Could not start the camera.";
}

/**
 * Reads barcodes from the phone (or laptop) camera, for when there is no hardware scanner. It hands each
 * code to onCode, the same way a hardware scanner's typed input would be.
 */
export function CameraScanner({ onCode, paused, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pausedRef = useRef(paused);
  const onCodeRef = useRef(onCode);
  const [error, setError] = useState<string | null>(null);

  // The scan loop below runs once; these keep it looking at the latest props.
  useEffect(() => {
    pausedRef.current = paused;
    onCodeRef.current = onCode;
  });

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let last = { value: "", seenAt: 0 };

    function handle(value: string) {
      const now = Date.now();
      // Still the same code in view: not a new scan.
      if (value === last.value && now - last.seenAt < REARM_MS) {
        last.seenAt = now;
        return;
      }
      // A different code while the last scan is processing: leave it unrecorded so it is picked up next.
      if (pausedRef.current) return;
      last = { value, seenAt: now };
      navigator.vibrate?.(40);
      onCodeRef.current(value);
    }

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera API");
        const detector = createDetector();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        const video = videoRef.current;
        if (cancelled || !video) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();

        const tick = async () => {
          if (cancelled) return;
          try {
            if (video.readyState >= 2) {
              const found = await detector.detect(video);
              const value = found[0]?.rawValue?.trim();
              if (value) handle(value);
            }
          } catch {
            // A frame that cannot be read is skipped; the next one is tried.
          }
          if (!cancelled) timer = window.setTimeout(tick, SCAN_INTERVAL_MS);
        };
        void tick();
      } catch (err) {
        if (!cancelled) setError(describeError(err));
      }
    }

    void start();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p role="alert" className="rounded-xl border border-bad bg-page px-3 py-2 text-sm text-bad">
          {error}
        </p>
      ) : (
        <div className="relative overflow-hidden rounded-xl border-2 border-brand bg-black">
          {/* playsInline and muted are required for the video to start on iPhones. */}
          <video ref={videoRef} playsInline muted className="aspect-[4/3] max-h-80 w-full object-cover" />
          <div aria-hidden className="pointer-events-none absolute inset-x-6 top-1/2 h-0.5 -translate-y-1/2 bg-bad/70" />
        </div>
      )}
      <div>
        <button type="button" onClick={onClose} className={`${ghostButtonClass} py-1`}>
          Close camera
        </button>
      </div>
    </div>
  );
}
