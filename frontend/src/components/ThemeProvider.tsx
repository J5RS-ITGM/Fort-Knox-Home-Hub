"use client";

import { useTheme } from "@/lib/theme";

/** Mounts the theme hook once, app-wide. Renders nothing — it just keeps
 *  the document's theme in sync with server settings + localStorage. */
export default function ThemeProvider() {
  useTheme();
  return null;
}
