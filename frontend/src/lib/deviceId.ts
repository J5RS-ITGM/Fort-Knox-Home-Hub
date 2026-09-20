/** A stable id for THIS screen (browser profile / installed PWA). Lets the
 *  same login keep a different wall-panel layout on the kitchen kiosk, a
 *  tablet, and a phone. Lives in localStorage; regenerated only if cleared. */
const KEY = "fk_device_id";
export function getDeviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (typeof crypto !== "undefined" && "randomUUID" in crypto)
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch { return "nolocal"; }
}
