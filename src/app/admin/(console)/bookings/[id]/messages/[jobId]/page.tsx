import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { and, eq } from "drizzle-orm";
import { AdminSection, NotReady } from "@/components/admin-ui";
import { adminContext } from "@/server/admin/context";
import { notificationJobs, reservations } from "@/server/db/schema";
import { prepare } from "@/server/notifications/dispatch";

export const metadata = { title: "Message preview" };

/**
 * Owner-only preview of a booking message, rendered from current data
 * exactly as the sender would. Useful while email delivery is switched off.
 * Rendered as plain text: no HTML from the template is injected here.
 */
export default function MessagePreviewPage({
  params,
}: PageProps<"/admin/bookings/[id]/messages/[jobId]">) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Preview params={params} />
    </Suspense>
  );
}

async function Preview({
  params,
}: {
  params: PageProps<"/admin/bookings/[id]/messages/[jobId]">["params"];
}) {
  const { id, jobId } = await params;
  const ctx = await adminContext();
  if (!ctx.ready) return <NotReady reason={ctx.reason} />;
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(id) || !uuid.test(jobId)) notFound();
  const [job] = await ctx.db
    .select({ job: notificationJobs })
    .from(notificationJobs)
    .innerJoin(
      reservations,
      eq(reservations.id, notificationJobs.reservationId),
    )
    .where(
      and(
        eq(notificationJobs.id, jobId),
        eq(notificationJobs.reservationId, id),
        eq(reservations.propertyId, ctx.property.id),
      ),
    );
  if (!job) notFound();
  const prepared = await prepare(ctx.db, job.job, ctx.now);

  return (
    <>
      <h1 className="text-title">Message preview</h1>
      <p className="mt-2">
        <Link
          href={`/admin/bookings/${id}`}
          className="underline underline-offset-4"
        >
          Back to booking
        </Link>
      </p>
      <div className="mt-6">
        <AdminSection
          id="message"
          title={job.job.template.replaceAll("_", " ")}
        >
          {"cancel" in prepared ? (
            <p>
              This message wouldn&rsquo;t be sent now (
              {prepared.cancel.toLowerCase()}).
            </p>
          ) : (
            <dl className="space-y-3">
              <div>
                <dt className="font-semibold">To</dt>
                <dd className="break-all">{prepared.to}</dd>
              </div>
              <div>
                <dt className="font-semibold">Subject</dt>
                <dd>{prepared.email.subject}</dd>
              </div>
              <div>
                <dt className="font-semibold">Text</dt>
                <dd>
                  <pre className="font-sans text-sm break-words whitespace-pre-wrap">
                    {/* Signed guest links are redacted: they grant access to the booking. */}
                    {prepared.email.text.replace(
                      /\?t=\S+/g,
                      "?t=[signed link]",
                    )}
                  </pre>
                </dd>
              </div>
            </dl>
          )}
        </AdminSection>
      </div>
    </>
  );
}
