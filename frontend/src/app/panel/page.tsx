"use client";

import dynamic from "next/dynamic";

// WallPanel drives WebGL + window listeners; render client-side only.
const WallPanel = dynamic(() => import("@/components/WallPanel.jsx"), {
  ssr: false,
  loading: () => (
    <div className="grid min-h-dvh place-items-center text-sm text-ink-muted">
      Loading panel…
    </div>
  ),
});

export default function PanelPage() {
  return <WallPanel />;
}
