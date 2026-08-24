# Guest access, groups, RBAC and administrator insight

This feature adds application-managed guest identities beside Microsoft Entra
login. It does not create guest users in the Entra tenant.

## Access model

- An internal user signs in through Microsoft Entra.
- A guest receives one personal `gst_...` code by email. The code can unlock
  several projects over time; each project has its own role and optional
  expiry. Adding a second project does not create a second guest or code.
- A direct project role and any group roles are combined. The strongest active
  role wins.
- Project roles are `owner`, `editor`, `viewer`, and `restricted_viewer`.
  Restricted viewers can read in the app but cannot download source documents.
- `admin` is the only global role. It manages roles and groups, can read every
  project, and can inspect the global activity stream. It does not receive
  global write access to project content.
- Authenticated route activity is scheduled for best-effort persistence in
  `activity_events`, including administrator reads, without delaying the
  response. Explicit access and role changes are still recorded synchronously.
  Events store actor, project/entity references and the operation, not a
  duplicate copy of raw document or prompt content. An administrator can open
  the referenced project to inspect the authoritative content.

The guest code is a bearer credential. Anyone who possesses it can use it, so
send it only to the intended recipient. Rotating a guest code immediately
revokes all active sessions for that guest.

## Cost impact

The RBAC, guest-code and activity logic has no separate software licence. It
adds ordinary PostgreSQL rows and data-API requests, so it can increase database
usage. Azure Communication Services Email
is consumption-billed per email. Microsoft Entra External ID pricing depends on
monthly active users and any premium add-ons; verify the current tenant pricing
before production. The application-managed guest flow itself does not create
additional External ID monthly active users.

## Apply the database migration

Apply `database/migrations/20260809141303_guest_rbac_superuser_insights.sql`
through the normal `database/migrations` pipeline before deploying the web
revision. The migration creates identities, database sessions, groups,
project grants, guest credentials and activity events. Existing project owners
are backfilled as owner memberships.

Then apply `database/migrations/20260812012210_admin_only_password_access.sql`
to remove the retired global role and enable dedicated administrator sessions.

Finally apply `database/migrations/20260812020933_simplify_admin_sessions.sql`
to revoke legacy password sessions and switch administrator updates to the
single boolean `set_principal_admin` RPC.

The data-API service-role key remains server-only. The migration enables RLS,
revokes `anon` and `authenticated`, and grants the new tables and RPCs
explicitly to `service_role`.

## Application secrets and bootstrap roles

Generate three independent random values (at least 32 random bytes each):

```sh
openssl rand -base64 48
```

Configure:

```dotenv
APP_GUEST_CODE_PEPPER=
APP_IDENTITY_LOOKUP_SECRET=
APP_ACTIVITY_HASH_SECRET=
APP_ADMIN_EMAILS=admin@example.no
APP_ADMIN_ACCESS_PASSWORD_HASH=scrypt\$... # Escape dollar signs in dotenv files.
APP_ADMIN_PRINCIPAL_ID=u_admin_<stable-random-identifier>
APP_ADMIN_DISPLAY_NAME=Administrator
```

`APP_ADMIN_EMAILS` is comma-separated. A matching administrator role is
synchronized when the internal user next signs in with Microsoft. Roles can
also be changed in **Styring og innsikt**.

Keep the HMAC secrets stable. Rotating `APP_GUEST_CODE_PEPPER` invalidates all
guest codes; rotating `APP_IDENTITY_LOOKUP_SECRET` prevents matching a new
invitation to an existing email identity.

For GitHub-based production deployments, store the three HMAC values as
repository or environment secrets with the same names. The deployment workflow
requires them so production cannot silently fall back to the session-signing
secret. Configure `APP_ADMIN_EMAILS`, `AZURE_COMMUNICATION_EMAIL_ENDPOINT`, and
`AZURE_COMMUNICATION_EMAIL_SENDER` as deployment variables when those optional
features are enabled.

The dedicated administrator password is stored only as an encoded scrypt hash.
The cleartext value belongs in a password manager and must never be committed,
logged, or stored in the database. Keep `APP_ADMIN_PRINCIPAL_ID` stable when
rotating the password so project and audit references remain intact.

## Azure Communication Services Email

This is the manual Azure work required to send guest codes:

1. Create an **Email Communication Services** resource. Choose either an
   Azure-managed domain or verify a custom sending domain.
2. Create or use an **Azure Communication Services** resource and connect the
   verified email domain to it.
3. Copy the Communication Services endpoint and the verified `MailFrom`
   address into:

   ```dotenv
   AZURE_COMMUNICATION_EMAIL_ENDPOINT=https://<name>.communication.azure.com
   AZURE_COMMUNICATION_EMAIL_SENDER=DoNotReply@<verified-domain>
   ```

4. The Bicep template now enables a system-assigned managed identity on the
   Container App. In the Communication Services resource, open **Access
   control (IAM)** and assign this identity a role that can send email.
   Microsoft's built-in broad option is **Communication and Email Service
   Owner**. Prefer a custom least-privilege role if your Azure governance team
   provides one for email sending.
5. Restart or redeploy the Container App and test an invitation. If delivery
   fails, the one-time code is still shown to the project owner so it can be
   transferred through an approved channel.

For local development only, the app also accepts
`AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING`. Do not use a long-lived
connection string in production when managed identity is available.

## Microsoft Entra External ID

The guest-code flow needs no new Entra user flow, guest invitation, API
permission or Microsoft Graph scope. It is application-managed.

For internal administrator identification:

1. Keep the existing web callback URI
   `/api/auth/microsoft/callback`.
2. In the app registration, ensure the ID token exposes an email-like
   `preferred_username` or `email` value for the internal users. The callback
   also falls back to the MSAL account username.
3. Keep authorization tied to the stable Entra account subject; email is used
   only to match bootstrap roles and audit identity.
4. Enforce MFA and an appropriate Conditional Access policy for accounts that
   receive `admin`.

If the tenant cannot reliably emit an email-like claim, the user can still log
in, but `APP_ADMIN_EMAILS` cannot match automatically.
In that case, bootstrap one role directly in `app_principal_roles`, then use
the admin UI for subsequent role assignment.

## Operational checks

- Invite a new guest and verify that the code works once delivered.
- Add the same email to a second project; verify that the original code opens
  both projects.
- Change each project role and verify read/write/download restrictions.
- Rotate the code and confirm that all existing guest sessions stop working.
- Revoke one project and confirm that other project access remains active.
- Revoke the final active project and confirm that the guest session is
  revoked.
- Confirm an admin can read every project and open the activity stream.
- Confirm an admin without a project role cannot change project content.
