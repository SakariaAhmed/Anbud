import { LoginForm } from "@/components/auth/login-form";
import { isMicrosoftAuthConfigured } from "@/lib/server/microsoft-auth";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  microsoft_cancelled: "Microsoft-innloggingen ble avbrutt.",
  microsoft_callback_failed:
    "Vi kunne ikke bekrefte Microsoft-kontoen. Prøv på nytt.",
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
  searchParams: Promise<{ authError?: string; next?: string }>;
}) {
  const { authError, next } = await searchParams;
  return (
    <LoginForm
      initialError={authError ? AUTH_ERROR_MESSAGES[authError] : undefined}
      microsoftEnabled={isMicrosoftAuthConfigured()}
      nextPath={next ?? "/"}
    />
  );
}
