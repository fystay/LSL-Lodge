import { Suspense } from "react";
import { adminAuthMode } from "@/server/admin/auth";
import { signInAction } from "../actions";

export const metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/admin/login">) {
  return (
    <main id="main" className="mx-auto w-full max-w-md flex-1 px-4 py-16">
      <h1 className="text-title">Owner sign-in</h1>
      <Suspense fallback={null}>
        <LoginForm searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function LoginForm({
  searchParams,
}: {
  searchParams: PageProps<"/admin/login">["searchParams"];
}) {
  const { error } = await searchParams;
  const mode = adminAuthMode();
  if (mode !== "local") {
    return (
      <p
        role="status"
        className="mt-6 rounded-soft border border-notice-ink/30 bg-notice p-4 text-notice-ink"
      >
        {mode === "supabase"
          ? "Owner sign-in with multi-factor authentication is being connected and isn’t available yet."
          : "Admin sign-in is not enabled on this deployment."}
      </p>
    );
  }
  return (
    <form action={signInAction} className="mt-8 space-y-5">
      <p className="text-sm text-ink-muted">
        Local development sign-in. Not available on deployed sites.
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-soft border border-danger/40 bg-ivory p-3 font-medium text-danger"
        >
          Those details weren&rsquo;t recognised.
        </p>
      )}
      <div>
        <label htmlFor="email" className="font-semibold text-pine-900">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className="mt-1.5 block min-h-12 w-full rounded-soft border border-sage-600/60 bg-ivory px-3"
        />
      </div>
      <div>
        <label htmlFor="password" className="font-semibold text-pine-900">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1.5 block min-h-12 w-full rounded-soft border border-sage-600/60 bg-ivory px-3"
        />
      </div>
      <button
        type="submit"
        className="min-h-12 rounded-soft bg-pine-800 px-6 font-semibold text-ivory hover:bg-pine-700"
      >
        Sign in
      </button>
    </form>
  );
}
