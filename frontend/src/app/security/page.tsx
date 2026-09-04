"use client";

import dynamic from "next/dynamic";
import AuthGate from "@/components/AuthGate";
import BottomTabs from "@/components/BottomTabs";

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
  return (
    <AuthGate>
      <SecurityBoard />
      <BottomTabs />
    </AuthGate>
  );
}
