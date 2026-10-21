import type { Metadata, Viewport } from "next";
import "./globals.css";

const title = "Portomatic: Local environments for your agents";
const description = "We build environments that run locally for your agents.";

export const metadata: Metadata = {
  metadataBase: new URL("https://portomatic.com"),
  title,
  description,
  alternates: { canonical: "/" },
  icons: {
    icon: [{ url: "/assets/favicon.svg", type: "image/svg+xml", sizes: "any" }],
  },
  openGraph: {
    title,
    description,
    url: "https://portomatic.com/",
    siteName: "Portomatic",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#faf9f6",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
