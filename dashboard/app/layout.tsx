import type { Metadata } from "next";
import "./globals.css";
import "./industrial.css";
import FieldChatProvider from "@/components/chat-provider";
export const metadata: Metadata = { title: "FIELDLINK · 장비 예측정비", description: "DAQ 기반 장비 상태 모니터링 및 예측정비 대시보드" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ko"><body><FieldChatProvider>{children}</FieldChatProvider></body></html>;
}
