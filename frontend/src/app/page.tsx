"use client";

// The dashboard now lives at /sensors. Keep "/" working for existing
// bookmarks and the PWA start_url by redirecting to it.
import { useEffect } from "react";

export default function Home() {
  useEffect(() => { window.location.replace("/sensors"); }, []);
  return (
    <div className="grid min-h-dvh place-items-center text-sm text-ink-muted">
      Loading…
    </div>
  );
}
