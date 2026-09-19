import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://portomatic.com/" },
    { url: "https://portomatic.com/docs" },
  ];
}
