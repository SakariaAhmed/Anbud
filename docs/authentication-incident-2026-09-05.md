# Production authentication incident — 2026-09-05

## Confirmed failure and live remediation

Azure Log Analytics recorded the following at 2026-09-04 21:56:20 UTC on
`anbud--sha-0ba4e687cb310fcd7bee152f2841125c0aea3b66`:

> Could not complete Microsoft authentication. Error: duplicate key value violates unique constraint "app_principal_roles_single_admin_idx"

The Microsoft callback completed token acquisition and identity persistence,
then `syncBootstrapRoles` attempted to insert an additional administrator for
an email listed in `APP_ADMIN_EMAILS`. The database's singleton administrator
index correctly rejected that grant. The callback hid the persistence failure
behind a Microsoft-account verification error.

A behavior regression reproduced the exact error before the code change.
The application no longer synchronizes global roles from email at login.
The dedicated password-backed administrator and existing project grants remain.

Live remediation was a configuration-only revision:

- App/resource group: `anbud` / `anbud-prod`.
- New revision: `anbud--authfix-20260905`.
- Removed environment variable: `APP_ADMIN_EMAILS`.
- Same deployed image digest: `sha256:36d559964d2192d617ed4a252d6394662a546ae0e7408b217a6b1bfdd1037e34`.
- Compared all other environment values and secret references: unchanged.
- Candidate health, login page, and Microsoft redirect checks passed before promotion.
- Public ingress was promoted to the healthy configuration-only revision.
- The subsequent administrator consolidation below supersedes this revision.

The user subsequently reached a page with their signed-in name and HTTP 404.
This confirms authentication now succeeds. The original screenshot's return
path appeared to target `/admin`; that route returns 404 for non-admin accounts.
The user confirmed that the project dashboard opens, but administrator access is absent. The user then authorized choosing the safest/easiest administrator arrangement. Their existing Microsoft identity was made the single administrator, with the existing password fallback mapped to the same principal.

### Administrator identity consolidation (live)

The recent Entra session resolved to the active internal identity named Sakaria.
Its principal was verified before changing access. The existing service-only
`set_principal_admin` RPC made that identity the singleton administrator and
revoked the former administrator's sessions. Verification found exactly one
global administrator, matching the intended Microsoft principal; the audit
write `admin.identity.consolidated` returned HTTP 201.

`APP_ADMIN_PRINCIPAL_ID` and `APP_ADMIN_DISPLAY_NAME` now identify that same
principal in both Azure and the GitHub production environment. The existing
administrator password/hash was preserved as a fallback for this identity.
`APP_ADMIN_EMAILS` was removed from the GitHub production variables.

Final revision: `anbud--authadmin-20260905`, using the same original image,
with 100% of public traffic. Both earlier revisions were deactivated after
confirming no project jobs were running. This prevents their obsolete password
identity settings from switching administrator ownership back. A rollback must
retain the consolidated administrator identity and omit `APP_ADMIN_EMAILS`.

The user confirmed that the production admin console opens after this change.
Final Azure verification showed only `anbud--authadmin-20260905` active, healthy,
and receiving 100% of traffic; the public liveness endpoint returned HTTP 200.

Microsoft MFA/Conditional Access policy is tenant-managed; this session did
not change or verify the external tenant's MFA policy.

## Additional code fixes prepared locally

1. Removed the retired email bootstrap from the repository, Bicep parameters,
   deployment workflow, environment example, and setup documentation.
2. Microsoft discovery failures no longer leave a permanently rejected promise
   cached on the replica. Discovery requests have a ten-second timeout.
3. Callback errors distinguish token, identity/session, and denied-access
   failures. A safe UUID reference connects the UI error with a structured log
   containing the stage and error code, without logging raw errors or tokens.
4. Signed-in non-admin users visiting `/admin` are redirected to the workspace.
   Unexpected backend errors are no longer swallowed as 404s.
5. Added migration `20260905030000_preserve_disabled_principals_on_login.sql`.
   The identity upsert no longer clears `disabled_at`; it rejects disabled
   subject/email/alias matches. The baseline schema contains the same fix.

These application changes and the SQL migration are **not deployed** by the
configuration-only production remediation. The SQL migration must be applied
through the normal migration process, followed by an application release.

## Review evidence

- Production `APP_PUBLIC_ORIGIN` matches the public HTTPS origin.
- OAuth redirect targets that origin's `/api/auth/microsoft/callback`.
- Entra External ID authority resolves to `bidsiteexternal.ciamlogin.com`.
- Live initiation returns S256 PKCE, state, nonce, and three flow cookies.
- Source verifies CSRF state, PKCE verifier, and nonce before persisting a session.
- Sessions are opaque credentials, HMAC-backed in PostgreSQL, with HttpOnly,
  SameSite=Lax, production Secure cookies and a bounded lifetime.
- Middleware resolves database sessions and strips/replaces identity headers.
  Server authorization rechecks the principal, session, and current roles.
- Database regression exercises active sessions, wrong credentials, disabled
  sessions, disabled subject/email login, identity immutability on denial, and
  singleton-administrator preservation as `service_role` in a disposable DB.
- Public ingress disallows HTTP; PostgREST uses the internal Container Apps host.
- OAuth and session credentials use Container Apps secret references. No secrets
  were rotated, printed, or added to the working tree.
- Scale-to-zero is enabled. Cold starts remain a latency consideration, but the
  confirmed callback exception was a role constraint, not a cold-start error.

## Validation

- 54 access/security/password/redirect tests passed.
- 17 focused callback, discovery, identity, admin-landing, redirect, and SQL
  regression tests passed (including isolated PostgreSQL runtime checks).
- Bicep compilation, deployment-workflow validation, and YAML parsing passed.
- Production login and OAuth-start checks returned HTTP 200/302 as expected.
- Final lint and production build passed. The localhost dev server was restarted.
