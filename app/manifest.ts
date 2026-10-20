import type { MetadataRoute } from "next";

// Makes the app installable on store and lab PCs and tablets (architecture section 6).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Consumables Tracker",
    short_name: "Consumables",
    description: "Barcode tracking for hospital consumables",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#f3f8f4",
    theme_color: "#075434",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
