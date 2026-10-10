import { NotFoundContent } from "@/components/not-found-content";

/**
 * notFound() inside a public page (e.g. a booking page without its access
 * cookie): the (site) layout already provides the header and footer, so only
 * the message goes here. Using the root not-found showed the chrome twice.
 */
export default function NotFound() {
  return <NotFoundContent />;
}
