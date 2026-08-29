import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HomeHub",
  description: "Local-first home control",
};

export const viewport: Viewport = {
  themeColor: "#0c1117",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-field text-ink antialiased">{children}</body>
    </html>
  );
}
