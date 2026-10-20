/** Centered loading indicator for the main content area. Shared by the layout fallback and loading.tsx. */
export function PageLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-4"
    >
      <span
        aria-hidden="true"
        className="h-10 w-10 animate-spin rounded-full border-4 border-side-line border-t-side-on-edge motion-reduce:animate-none"
      />
      <p className="text-lg font-medium text-muted">Loading...</p>
    </div>
  );
}
