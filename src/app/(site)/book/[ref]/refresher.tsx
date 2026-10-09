"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the booking page every few seconds while a payment is being
 * confirmed server-side, up to a limit. The server decides what is shown.
 */
export function StatusRefresher({
  everyMs = 4000,
  maxTimes = 15,
}: {
  everyMs?: number;
  maxTimes?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      if (count > maxTimes) clearInterval(timer);
      else router.refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs, maxTimes]);
  return null;
}
