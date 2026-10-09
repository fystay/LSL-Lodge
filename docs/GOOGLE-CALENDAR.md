# Google Calendar integration: assessment

Status (9 October 2026): **not built; prepared.** It needs a Google Cloud
project, an OAuth client and the owner's approval of which account and
calendars to use. No live calendar has been connected or written to.

## What it would do

1. **Read busy times** from calendars the owner picks (for example a
   personal calendar where they note family use), so those dates block
   direct bookings. Uses the free/busy API: only busy intervals, never
   event titles, guests or descriptions.
2. **Optionally write website bookings** to a calendar the app creates for
   itself ("Lodge on the Lake bookings"), so they show on the owner's phone.
   Writing stays off until separately approved.

## Scopes (least privilege)

| Scope                                                      | For                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `https://www.googleapis.com/auth/calendar.events.freebusy` | Busy times only, on calendars the owner selects                               |
| `https://www.googleapis.com/auth/calendar.app.created`     | Create and manage only the app's own calendar (writes), never other calendars |

Google's verification requirements for these scopes must be checked when
the project is created. A project left in "testing" status issues refresh
tokens that expire after 7 days, which would force a weekly reconnect.

## What the owner needs to set up

1. A Google Cloud project owned by the business account.
2. OAuth consent screen (External; the owner's Google account as a test user
   until verified).
3. An OAuth client (Web application) with the redirect URI
   `https://<site>/api/integrations/google/callback` (and the preview URL for
   testing).
4. Client ID and secret in the hosting provider's environment
   (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   `GOOGLE_OAUTH_REDIRECT_URI`; already listed in `.env.example`). Never in
   chat or git.
5. A decision on which calendars to read, and whether to enable writing.

## How it fits what exists

The schema is ready: `external_calendar_sources` (provider `GOOGLE`, an
encrypted refresh token in `encrypted_config`), `external_busy_periods`
(imported busy time, blocking like Airbnb), and `calendar_event_links`
(maps a reservation to the event the app created). Health, staleness,
conflict alerts, the sync lease and the scheduler apply unchanged.

Implementation plan, once the above exists:

1. Connect flow in `/admin/calendars` (owner, fresh second factor): OAuth
   authorisation-code flow with `state` and PKCE, `access_type=offline`,
   `prompt=consent`. The callback stores only the encrypted refresh token and
   the chosen calendar IDs. Disconnect revokes the token at Google and
   clears it.
2. Busy-time import in the `sync-calendars` job: query free/busy over the
   booking horizon (the API limits the window per call, so query in
   chunks), convert busy intervals to blocked nights conservatively (any
   part of a day blocks that night, as for timed iCal events), and
   reconcile with the same held-removal safety as Airbnb.
3. Errors: 401/`invalid_grant` → mark DISCONNECTED and alert (reconnect
   needed); 403/429 → back off; 5xx → retry; tokens never logged.
4. Writes (only with `GOOGLE_CALENDAR_WRITE_APPROVED=true`): create the
   app's calendar once, then create/update/delete one all-day event per
   confirmed booking with the reservation ID in
   `extendedProperties.private`, tracked in `calendar_event_links`. The app
   only ever modifies events it created; it never deletes anything it
   can't identify as its own.
5. Tests: OAuth callback (state mismatch, error, success), token refresh
   and revocation, free/busy conversion across daylight-saving changes,
   paging the time window, reconciliation and write idempotency, all
   against a mocked Google API.

Not used for availability decisions until the owner has connected it and
the import has run successfully at least once.
