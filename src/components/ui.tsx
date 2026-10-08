import Link from "next/link";
import type { Route } from "next";
import type { ComponentProps, ReactNode } from "react";
import { isVerified, type Fact } from "@/content/property";

export function Container({ className = "", ...props }: ComponentProps<"div">) {
  return (
    <div
      className={`mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 ${className}`}
      {...props}
    />
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm font-semibold tracking-[0.14em] text-wood uppercase">
      {children}
    </p>
  );
}

export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="border-b border-sage-300/60 bg-limestone/60">
      <Container className="py-14 sm:py-20">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="mt-3 max-w-3xl text-title">{title}</h1>
        {children && (
          <div className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-muted">
            {children}
          </div>
        )}
      </Container>
    </header>
  );
}

const buttonBase =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-soft px-6 text-base font-semibold transition-colors duration-200 ease-calm";

const buttonVariants = {
  primary: "bg-pine-800 text-ivory hover:bg-pine-700",
  secondary: "border border-pine-800 text-pine-900 hover:bg-sage-100",
  light: "bg-ivory text-pine-900 hover:bg-limestone",
} as const;

export function ButtonLink({
  href,
  variant = "primary",
  className = "",
  children,
}: {
  href: Route;
  variant?: keyof typeof buttonVariants;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`${buttonBase} ${buttonVariants[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}

export function buttonClasses(
  variant: keyof typeof buttonVariants = "primary",
) {
  return `${buttonBase} ${buttonVariants[variant]}`;
}

/**
 * Marks content that the owner has not yet confirmed. Visible text (not only
 * colour) so the status is clear to everyone, including screen-reader users.
 */
export function Unconfirmed({ label = "To be confirmed" }: { label?: string }) {
  return (
    <span className="ml-2 inline-flex items-center rounded-full border border-notice-ink/30 bg-notice px-2 py-0.5 align-middle font-sans text-xs font-semibold tracking-normal text-notice-ink">
      {label}
    </span>
  );
}

/** Renders a fact with an "unconfirmed" marker when the owner has not verified it. */
export function FactText<T>({
  fact,
  render,
  missing = "Details to follow",
}: {
  fact: Fact<T | null>;
  render?: (value: T) => ReactNode;
  missing?: string;
}) {
  if (fact.value === null || fact.value === undefined) {
    return (
      <span className="text-ink-muted">
        {missing}
        <Unconfirmed label="Awaiting owner" />
      </span>
    );
  }
  return (
    <>
      {render ? render(fact.value) : String(fact.value)}
      {!isVerified(fact) && <Unconfirmed />}
    </>
  );
}

/** A clearly labelled block of content still to be written or approved. */
export function DraftNotice({
  title = "Draft",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside
      className="rounded-soft border border-notice-ink/25 bg-notice p-5 text-notice-ink"
      aria-label={title}
    >
      <p className="font-semibold">{title}</p>
      <div className="mt-1 text-[0.95rem] leading-relaxed">{children}</div>
    </aside>
  );
}
