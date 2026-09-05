import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const spaceGrotesk = localFont({
  src: "./fonts/space-grotesk-latin.woff2",
  weight: "400 500",
  display: "block",
  variable: "--font-space-grotesk",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://portomatic.com"),
  title: "Portomatic",
  description: "The iPhone that runs on Linux.",
  alternates: { canonical: "/" },
  icons: {
    icon: [{ url: "/assets/favicon.svg", type: "image/svg+xml", sizes: "any" }],
  },
  openGraph: {
    title: "Portomatic",
    description: "The iPhone that runs on Linux.",
    url: "https://portomatic.com/",
    siteName: "Portomatic",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#f5f8fa",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={spaceGrotesk.variable}>
      <body className="bg-background font-sans text-foreground">
        {children}
      </body>
    </html>
  );
}
