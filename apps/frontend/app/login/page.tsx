import { LoginForm } from "@/components/auth/login-form";
import { isAdminPasswordAuthConfigured } from "@/lib/server/admin-password-auth";
import { isMicrosoftAuthConfigured } from "@/lib/server/microsoft-auth";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  microsoft_cancelled: "Microsoft-innloggingen ble avbrutt.",
  microsoft_callback_failed:
    "Vi kunne ikke bekrefte Microsoft-kontoen. Prøv på nytt.",
  microsoft_session_failed:
    "Microsoft-kontoen ble bekreftet, men vi kunne ikke opprette en innlogget økt. Prøv igjen om litt, eller kontakt administrator.",
  microsoft_access_denied:
    "Kontoen har ikke tilgang til å logge inn. Kontakt administrator.",
  microsoft_callback_invalid:
    "Innloggingsforsøket er utløpt eller ugyldig. Start på nytt.",
  microsoft_not_configured:
    "Microsoft-innlogging er ikke ferdig konfigurert for dette miljøet.",
  microsoft_start_failed:
    "Microsoft-innlogging kunne ikke startes. Prøv igjen om litt.",
  rate_limited: "For mange innloggingsforsøk. Prøv igjen om litt.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string; authRef?: string; next?: string }>;
}) {
  const { authError, authRef, next } = await searchParams;
  const message = authError ? AUTH_ERROR_MESSAGES[authError] : undefined;
  const reference = authRef && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(authRef)
    ? authRef
    : undefined;
  return (
    <LoginForm
      initialError={message && reference ? `${message} Referanse: ${reference}` : message}
      microsoftEnabled={isMicrosoftAuthConfigured()}
      adminPasswordEnabled={isAdminPasswordAuthConfigured()}
      nextPath={next ?? "/"}
    />
  );
}
