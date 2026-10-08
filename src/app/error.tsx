"use client";

import { Container } from "@/components/ui";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Container className="py-24 text-center">
      <h1 className="text-title">Something went wrong</h1>
      <p className="mx-auto mt-4 max-w-md text-ink-muted">
        Sorry, this page didn&rsquo;t load properly. Please try again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-8 min-h-12 rounded-soft bg-pine-800 px-6 font-semibold text-ivory hover:bg-pine-700"
      >
        Try again
      </button>
    </Container>
  );
}
