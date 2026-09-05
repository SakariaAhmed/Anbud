# Microsoft Entra External ID login

Bidsite uses Microsoft Entra External ID directly through Microsoft's MSAL Node library. Application sessions and access records are stored in PostgreSQL.

## Cost and data minimization

Microsoft states that the External ID core offering is free for the first 50,000 monthly active users. A group of about 20 monthly active users is therefore within the free tier, provided no premium add-ons are enabled. Check the [current External ID pricing documentation](https://learn.microsoft.com/en-us/entra/external-id/external-identities-pricing) before production rollout.

The implementation deliberately minimizes stored identity data:

- No separate database-authentication user is created.
- No Microsoft Graph scopes are requested.
- The validated ID token and account object exist only in memory during the callback and are discarded immediately.
- The app session cookie contains an opaque random database-session credential.
  It contains no name, email address, tenant ID, or Microsoft user ID. Only a
  hash of the credential is persisted, and a logout or role-driven revocation
  can invalidate it server-side.
- The PKCE verifier and CSRF state are stored in short-lived, HttpOnly cookies for a maximum of ten minutes and are deleted after the callback.

Microsoft Entra External ID still stores the user identity in the External ID tenant because it is the identity provider.

## Configure the External ID tenant

1. Create or select a Microsoft Entra External ID external tenant and link it to an Azure subscription as required by Microsoft.
2. Register a web application in the external tenant.
3. Add these `Web` redirect URIs under the app registration's Authentication settings:
   - `http://localhost:3000/api/auth/microsoft/callback`
   - `https://<production-domain>/api/auth/microsoft/callback`
4. Create a client secret and store its **value**, not its secret ID. Set a reminder before its expiry.
5. Create a sign-up and sign-in user flow and associate the application with it. For a controlled group of about 20 users, do not collect optional profile attributes the app does not need, and configure registration/access so only the intended users can enter.
6. Record the application client ID and the tenant subdomain. For `contoso.onmicrosoft.com`, the tenant subdomain is `contoso`; the app derives the tenant-specific authority under `https://contoso.ciamlogin.com/contoso.onmicrosoft.com/`.

The callback must be registered as a server-side `Web` redirect URI, not as a single-page application redirect URI. Microsoft documents the current flow in its [Node web app sign-in tutorial](https://learn.microsoft.com/en-us/entra/identity-platform/tutorial-web-app-node-sign-in-sign-out).

## Environment variables

```dotenv
APP_PUBLIC_ORIGIN=http://localhost:3000
MICROSOFT_ENTRA_CLIENT_ID=
MICROSOFT_ENTRA_CLIENT_SECRET=
MICROSOFT_ENTRA_TENANT_SUBDOMAIN=
```

`APP_SESSION_SECRET` remains required to protect the opaque session
credential after Microsoft validates the login.

This integration intentionally accepts only the standard `<tenant-subdomain>.ciamlogin.com` External ID authority. Supporting a workforce tenant or custom authority should be a separate, reviewed configuration change.

## Production checklist

- Store `MICROSOFT_ENTRA_CLIENT_SECRET` as a secret, never a regular variable or client-side value.
- Set `APP_PUBLIC_ORIGIN` to the canonical HTTPS origin without a path or trailing callback segment.
- Keep the production redirect URI list short and remove retired domains.
- Verify one successful login, one cancelled login, an expired callback, and
  (in development only) the explicitly enabled local password login.
- Confirm the login only creates the expected application identity and session records.

## Login failure handling and administrator access

Microsoft sign-in resolves an application principal and creates an opaque
session. It does not assign the global administrator role. The configured
`APP_ADMIN_PRINCIPAL_ID` identifies the singleton administrator;
`APP_ADMIN_EMAILS` is retired and must not be passed to running revisions.
For a Microsoft-backed administrator, set this ID to the verified existing
Entra application principal and use the explicit administrator-assignment RPC.
The password fallback must reference the same principal, including in GitHub
production variables, so it cannot move the singleton role to another identity.

A member following a saved `/admin` login destination is sent to the project
workspace after authentication. Administrator authorization is still enforced;
this redirect does not grant administration access. Unexpected database failures
on the administrator page propagate to error handling instead of becoming 404s.

Failure redirects distinguish token verification (`microsoft_callback_failed`),
application identity/session persistence (`microsoft_session_failed`), and denied
identities (`microsoft_access_denied`). Unexpected failures include a UUID
`authRef`, also recorded in a `microsoft_auth_failed` server log with the stage
and safe error code. Never log token responses, codes, cookies, credentials, or
raw identity payloads. A failed discovery request is evicted from the shared
cache so later logins can retry; discovery is bounded to ten seconds.

Apply `database/migrations/20260905011500_preserve_disabled_principals_on_login.sql`
through the database migration process. Login must not reactivate a disabled
principal, including when it is found by email or alias. The regression runs
against an isolated disposable database when
`PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL` is set.
