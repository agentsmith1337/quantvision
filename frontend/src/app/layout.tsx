import type { Metadata } from "next";
import { Google_Sans, JetBrains_Mono, Outfit } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

const googleSans = Google_Sans({ variable: "--font-google-sans", subsets: ["latin"] });
const outfit = Outfit({ variable: "--font-outfit", subsets: ["latin"] });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "QuantVision",
  description: "Local algorithmic trading engine for Angel One",
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${googleSans.variable} ${outfit.variable} ${jetbrainsMono.variable} antialiased`}
    >
      <body className="font-sans">
        <ThemeProvider attribute="data-theme" themes={["day", "evening", "dark"]} defaultTheme="dark" enableSystem={false}>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
