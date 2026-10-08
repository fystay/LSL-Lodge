"use server";

import {
  readEnquiry,
  type EnquiryField,
  type EnquiryState,
} from "@/server/contact/enquiry";
import { randomUUID } from "node:crypto";
import {
  getEmailSender,
  ownerNotificationAddress,
} from "@/server/notifications/email";

export async function submitEnquiry(
  _previous: EnquiryState,
  form: FormData,
): Promise<EnquiryState> {
  const { values, result } = readEnquiry(form);

  if (!result.success) {
    const errors: Partial<Record<EnquiryField, string>> = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (field === "website") {
        // Honeypot tripped: respond as if invalid without explaining why.
        return { status: "error", values };
      }
      if (
        (field === "name" || field === "email" || field === "message") &&
        !errors[field]
      ) {
        errors[field] = issue.message;
      }
    }
    return { status: "invalid", errors, values };
  }

  const sender = getEmailSender();
  const ownerAddress = ownerNotificationAddress();
  if (!sender || !ownerAddress) {
    // No email provider yet: say so plainly and keep what the visitor typed.
    return { status: "unavailable", values };
  }

  try {
    await sender.send({
      to: ownerAddress,
      replyTo: result.data.email,
      subject: "New enquiry from the website",
      text: `From: ${result.data.name} <${result.data.email}>\n\n${result.data.message}`,
      idempotencyKey: `enquiry:${randomUUID()}`,
    });
  } catch {
    return { status: "error", values };
  }
  return { status: "sent" };
}
