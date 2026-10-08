import type { Metadata } from "next";
import { privateRouteMetadata } from "@/lib/metadata";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Admin · Lodge on the Lake" },
  ...privateRouteMetadata,
};

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
