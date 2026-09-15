"use client";

import dynamic from "next/dynamic";
import AuthGate from "@/components/AuthGate";

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
  return (
    <AuthGate>
      <WallPanel />
    </AuthGate>
  );
}
