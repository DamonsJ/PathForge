import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pathforge — NC GPU Path Inspector",
  description: "面向大型 NC 文件的高性能 WebGL 路径查看与点拾取工具。",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
