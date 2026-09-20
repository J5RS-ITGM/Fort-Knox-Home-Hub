"use client";

/** Route template: re-mounts on every navigation, so the incoming screen
 *  fades in under the persistent nav bars instead of popping. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="hh-page-enter">{children}</div>;
}
