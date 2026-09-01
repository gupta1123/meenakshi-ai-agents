import type { Metadata } from "next";

import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/poppins/800.css";
import "@fontsource/jetbrains-mono/500.css";
import { CollectionsAppProvider } from "@/components/collections/collections-app-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Meenakshi Collections",
  description: "Meenakshi Cash Discount and Turnover Discount operations",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><CollectionsAppProvider>{children}</CollectionsAppProvider></body>
    </html>
  );
}
