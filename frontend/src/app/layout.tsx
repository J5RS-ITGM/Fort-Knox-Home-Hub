import type { Metadata, Viewport } from "next";
import "./globals.css";
import SWRegister from "@/components/SWRegister";
import SensorFlash from "@/components/SensorFlash";
import ThemeProvider from "@/components/ThemeProvider";
import MobileNav from "@/components/MobileNav";
import BottomTabs from "@/components/BottomTabs";
import KioskKeyboard from "@/components/KioskKeyboard";
import Screensaver from "@/components/Screensaver";
import VoiceProvider from "@/components/VoiceProvider";
import { themeBootScript } from "@/lib/theme";

export const metadata: Metadata = {
  title: "HomeHub",
  description: "Local-first home control",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "HomeHub" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0c1117",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* set theme before first paint to avoid a flash of the wrong theme */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className="bg-field text-ink antialiased">
        <ThemeProvider />
        <SWRegister />
        <SensorFlash />
        <MobileNav />
        {/* Kiosk bottom tabs live here (not per page) so they persist across
            navigation instead of unmounting/remounting with each screen.
            Below the tb breakpoint MobileNav's bar is used instead. */}
        <div className="hidden tb:block"><BottomTabs /></div>
        <div id="hh-shell" className="hh-shell">
          <div className="mobile-nav-pad">{children}</div>
        </div>
        {/* Screensaver sits under the alarm/leak overlays and the PIN pad
            (see its z-order note) and only auto-starts in kiosk mode. */}
        <Screensaver />
        <VoiceProvider />
        <KioskKeyboard />
      </body>
    </html>
  );
}
