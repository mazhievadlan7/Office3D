import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Oswald } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "Office3D",
  description: "Операторская студия для шлюза OpenClaw.",
};

/**
 * Oswald rather than Bebas Neue, and this is not a taste decision: Bebas Neue
 * has no Cyrillic at all, so every Russian heading would fall back to a system
 * font and the typography would break across the whole app. Oswald is the
 * nearest condensed display face that ships Cyrillic.
 */
const display = Oswald({
  variable: "--font-display",
  weight: "400",
  subsets: ["latin", "cyrillic"],
});

const sans = IBM_Plex_Sans({
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin", "cyrillic"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin", "cyrillic"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('theme');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=t?t==='dark':m;document.documentElement.classList.toggle('dark',d);}catch(e){}})();",
          }}
        />
      </head>
      <body className={`${display.variable} ${sans.variable} ${mono.variable} antialiased`}>
        <main className="h-screen w-screen overflow-hidden bg-background">{children}</main>
      </body>
    </html>
  );
}
