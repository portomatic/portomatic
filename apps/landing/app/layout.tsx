import type { Metadata, Viewport } from "next";
import "./globals.css";

const title = "Portomatic: Environments for coding agents";
const description = "We create environments that run locally to test your agents.";

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
