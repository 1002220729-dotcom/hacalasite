# Portal authentication

The system administrator entry uses Google Sign-In. The Worker verifies Google's RSA signature, issuer, client ID, token time limits, verified email, Workspace authority (or Gmail), and a single-use server nonce. An authorized email is bound to Google's stable subject ID on first successful login.

Four-hour opaque bearer sessions are stored in sessionStorage per browser tab. Only token hashes are stored in D1. Membership is checked on every API request; revocation takes effect immediately. Tokens are never placed in URLs or sent to external services. Same-origin report tabs obtain a session through BroadcastChannel. Signing out revokes the server session and clears same-origin tabs. Authenticated API responses are not cached by the service worker.

## Roles

- `system_admins`: Google accounts authorized to manage the entire system. This is separate from school principals in the legacy `admins` table.
- Instructors: assigned schools and their supervisor/principal assignments.
- Supervisors: read access to assigned schools.
- School principals: read access and an explicit whitelist of basic school fields for their assigned schools.
- Navigation visibility never grants permission to school data. Its settings can be changed only by system administrators.

## Transfer management

In the sidebar, open **מנהלי מערכת והעברת ניהול**, add a name and Google account email, and have that person sign in using **כניסת מנהל/ת מערכת**. Once their first login is shown as confirmed, the previous administrator can remove their own access. D1 triggers prevent deletion of the last confirmed administrator, including concurrent removals. A pending invitation does not count as a confirmed replacement. Adding a record does not send an email.

## Deployment

Back up the deployed Worker, settings, and D1 database before deployment. Apply `migrations/0001_auth.sql` once through Wrangler migrations; privately insert the explicitly authorized initial administrator in D1. Do not embed the initial administrator's email or a secret in published client code. Deploy the Worker, then publish the front-end on the main branch used by Cloudflare Pages and GitHub Pages.

Legacy client-created sessions and the former shared password no longer grant API access. Existing role records and school data are preserved. Instructors need explicit school/year assignments for cloud access; administrators can manage these in the existing instructor panel.

## Verification

`npm test` checks forged/expired/replayed Google tokens, authorization boundaries, transfer, immediate revocation, last-admin protection under concurrent removals, principal field restrictions, CORS, and logout. Separate local browser and Cloudflare runtime checks cover login rendering, report tabs, restored sessions, D1 migrations and triggers. Real Google account sign-in is completed by the account owner after publication.

Google token verification follows [Google's server-side verification guide](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
