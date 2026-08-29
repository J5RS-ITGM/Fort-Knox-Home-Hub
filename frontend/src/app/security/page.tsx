"use client";

import dynamic from "next/dynamic";

// SecurityBoard drives WebGL + pointer capture; render client-side only.
const SecurityBoard = dynamic(() => import("@/components/SecurityBoard.jsx"), {
  ssr: false,
  loading: () => (
    <div className="grid min-h-dvh place-items-center text-sm text-ink-muted">
      Loading security board…
    </div>
  ),
});

export default function SecurityPage() {
  return <SecurityBoard />;
}
