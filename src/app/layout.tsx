import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Casamable Control Center",
  description: "Centro de operaciones de Casamable: pedidos, confirmación, seguimiento y crecimiento.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f5f5f7",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-brand-bg text-brand-text antialiased">{children}</body>
    </html>
  );
}
