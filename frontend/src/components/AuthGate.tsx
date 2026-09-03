"use client";

/** Client-side auth gate. Real enforcement lives in the backend (401s +
 *  cookie sessions); this just avoids rendering protected UI to signed-out
 *  visitors and handles the redirect. */

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useMe } from "@/lib/auth";

export default function AuthGate({
  children,
  adminOnly = false,
}: {
  children: React.ReactNode;
  adminOnly?: boolean;
}) {
  const { me, loading } = useMe();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !me) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [loading, me, router, pathname]);

  if (loading || !me) {
    return (
      <div className="grid min-h-dvh place-items-center text-sm text-ink-muted">…</div>
    );
  }
  if (adminOnly && me.role !== "admin") {
    return (
      <div className="grid min-h-dvh place-items-center text-sm text-ink-muted">
        Admin access required.
      </div>
    );
  }
  return <>{children}</>;
}
