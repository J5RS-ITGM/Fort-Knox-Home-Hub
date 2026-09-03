import type { Metadata, Viewport } from "next";
import "./globals.css";
import SWRegister from "@/components/SWRegister";

export const metadata: Metadata = {
  title: "HomeHub",
  description: "Local-first home control",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "HomeHub" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0c1117",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-field text-ink antialiased">
        <SWRegister />
        {children}
      </body>
    </html>
  );
}
