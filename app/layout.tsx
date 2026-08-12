import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "CANON · EDA Online Viewer";
  const description =
    "在线解析并查看 KiCad、JLCEDA / EasyEDA 工程的原理图、PCB 2D、板级 3D、BOM、Netlist 与统一 IR，并安全摄取 Altium 工程结构。";
  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: `${origin}/og-viewer.png`, width: 1731, height: 909, alt: "CANON EDA Online Viewer" }],
    },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og-viewer.png`] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
