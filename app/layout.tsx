import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Google_Sans, Google_Sans_Code, Instrument_Serif, Noto_Sans_Arabic } from "next/font/google";
import "./globals.css";

// Self-hosted at build time: the browser never calls Google. The CSS
// variables feed the font tokens in globals.css.
const googleSans = Google_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-google-sans" });
const googleSansCode = Google_Sans_Code({ subsets: ["latin"], variable: "--font-google-sans-code" });
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: "italic",
  variable: "--font-instrument-serif",
});
const notoSansArabic = Noto_Sans_Arabic({ subsets: ["arabic"], variable: "--font-noto-arabic" });
const fontVariables = [googleSans, googleSansCode, instrumentSerif, notoSansArabic].map((font) => font.variable).join(" ");

export const metadata: Metadata = {
  title: "Amitec Reply - Open source Instagram comment-to-DM automation",
  description:
    "A free, self-hosted ManyChat alternative. Send an Instagram DM automatically when someone comments a keyword on your post or reel, using the official Meta API.",
  keywords: [
    "instagram automation",
    "comment to DM",
    "instagram private replies",
    "social commerce",
    "manychat alternative",
  ],
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Amitec Reply",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#f6f4f1", // bone, the page colour (app/globals.css)
  width: "device-width",
  initialScale: 1,
  // Installed on iOS the app owns the full screen, notch included; the safe
  // area insets below keep content clear of the system UI.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${fontVariables} h-full dark`}>
      <body
        className="min-h-full bg-background text-foreground font-sans antialiased"
        // Clears the home indicator when installed; 0 everywhere else.
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}
