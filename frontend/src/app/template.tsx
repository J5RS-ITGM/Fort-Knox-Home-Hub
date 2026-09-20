"use client";

/** Route template: re-mounts on every navigation, so the incoming screen
 *  fades in under the persistent nav bars instead of popping, and the app
 *  shell scrolls back to the top (the document itself never scrolls). */
import { useEffect } from "react";

export default function Template({ children }: { children: React.ReactNode }) {
  useEffect(() => { document.getElementById("hh-shell")?.scrollTo({ top: 0 }); }, []);
  return <div className="hh-page-enter">{children}</div>;
}
