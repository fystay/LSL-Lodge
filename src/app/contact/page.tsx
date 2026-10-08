import { Container, FactText, PageHeader } from "@/components/ui";
import { property } from "@/content/property";
import { pageMetadata } from "@/lib/metadata";
import { EnquiryForm } from "./enquiry-form";

export const metadata = pageMetadata(
  "/contact",
  "Contact",
  "Questions about Lodge on the Lake? Get in touch with the owner.",
);

export default function ContactPage() {
  return (
    <>
      <PageHeader eyebrow="Contact" title="Talk to the owner">
        <p>
          Questions about the lodge, dates or a longer stay? We&rsquo;re glad to
          help.
        </p>
      </PageHeader>
      <Container className="grid gap-12 py-14 sm:py-16 lg:grid-cols-[1fr_1.4fr]">
        <section aria-labelledby="details-title">
          <h2 id="details-title" className="text-2xl">
            Contact details
          </h2>
          <dl className="mt-4 space-y-4">
            <div>
              <dt className="font-semibold text-pine-900">Email</dt>
              <dd>
                <FactText
                  fact={property.contact.email}
                  render={(email) => (
                    <a
                      href={`mailto:${email}`}
                      className="underline underline-offset-4"
                    >
                      {email}
                    </a>
                  )}
                />
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-pine-900">Phone</dt>
              <dd>
                <FactText fact={property.contact.phone} />
              </dd>
            </div>
          </dl>
        </section>
        <section aria-labelledby="form-title">
          <h2 id="form-title" className="text-2xl">
            Send a message
          </h2>
          <div className="mt-5">
            <EnquiryForm />
          </div>
        </section>
      </Container>
    </>
  );
}
