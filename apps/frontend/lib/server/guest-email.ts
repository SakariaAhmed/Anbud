import "server-only";

import { EmailClient } from "@azure/communication-email";
import { DefaultAzureCredential } from "@azure/identity";

function emailClient() {
  const connectionString =
    process.env.AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING?.trim();
  if (connectionString) {
    return new EmailClient(connectionString);
  }
  const endpoint = process.env.AZURE_COMMUNICATION_EMAIL_ENDPOINT?.trim();
  if (endpoint) {
    return new EmailClient(endpoint, new DefaultAzureCredential());
  }
  return null;
}

export function isGuestEmailConfigured() {
  return Boolean(
    process.env.AZURE_COMMUNICATION_EMAIL_SENDER?.trim() &&
      (process.env.AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING?.trim() ||
        process.env.AZURE_COMMUNICATION_EMAIL_ENDPOINT?.trim()),
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function sendGuestAccessEmail(input: {
  email: string;
  displayName: string;
  projectName: string;
  roleLabel: string;
  identityType?: "internal" | "guest";
  guestCode?: string | null;
  expiresAt?: string | null;
}) {
  const client = emailClient();
  const senderAddress =
    process.env.AZURE_COMMUNICATION_EMAIL_SENDER?.trim();
  if (!client || !senderAddress) {
    return {
      delivered: false as const,
      reason: "Azure Communication Services Email er ikke konfigurert.",
    };
  }

  const publicOrigin = process.env.APP_PUBLIC_ORIGIN?.trim();
  if (!publicOrigin) {
    return {
      delivered: false as const,
      reason: "APP_PUBLIC_ORIGIN er ikke konfigurert.",
    };
  }

  const loginUrl = new URL("/login", publicOrigin).toString();
  const codeSection = input.guestCode
    ? `
      <p style="margin:24px 0 8px;color:#475569;font-size:13px">Din personlige gjestekode</p>
      <p style="margin:0 0 24px;padding:16px;border:1px solid #bfdbfe;border-radius:10px;background:#eff6ff;color:#0f172a;font-family:monospace;font-size:20px;letter-spacing:1px">${escapeHtml(input.guestCode)}</p>
      <p style="color:#64748b;font-size:13px">Koden er personlig. Ikke videresend den.</p>
    `
    : input.identityType === "internal"
      ? `
      <p style="color:#475569">Logg inn med Microsoft-kontoen som er knyttet til denne e-postadressen.</p>
    `
    : `
      <p style="color:#475569">Bruk den eksisterende gjestekoden din. Hvis du ikke lenger har koden, be prosjekteieren om å rotere og sende en ny.</p>
    `;
  const expiryText = input.expiresAt
    ? `Tilgangen utløper ${new Intl.DateTimeFormat("nb-NO", {
        dateStyle: "long",
      }).format(new Date(input.expiresAt))}.`
    : "Tilgangen gjelder til den trekkes tilbake.";

  const poller = await client.beginSend({
    senderAddress,
    recipients: {
      to: [
        {
          address: input.email,
          displayName: input.displayName,
        },
      ],
    },
    content: {
      subject: `Du har fått tilgang til ${input.projectName} i Bidsite`,
      plainText: [
        `Hei ${input.displayName},`,
        "",
        `Du har fått rollen ${input.roleLabel} i prosjektet ${input.projectName}.`,
        input.guestCode
          ? `Din personlige gjestekode er: ${input.guestCode}`
          : input.identityType === "internal"
            ? "Logg inn med Microsoft-kontoen din."
          : "Bruk den eksisterende gjestekoden din.",
        expiryText,
        `Logg inn på ${loginUrl}`,
      ].join("\n"),
      html: `
        <div style="max-width:560px;margin:0 auto;padding:32px;font-family:Arial,sans-serif;color:#0f172a">
          <p style="margin:0 0 8px;color:#2563eb;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">Bidsite · Prosjekttilgang</p>
          <h1 style="margin:0 0 18px;font-size:28px;line-height:1.2">Hei ${escapeHtml(input.displayName)}</h1>
          <p style="color:#475569;line-height:1.6">Du har fått rollen <strong>${escapeHtml(input.roleLabel)}</strong> i prosjektet <strong>${escapeHtml(input.projectName)}</strong>.</p>
          ${codeSection}
          <p style="color:#475569">${escapeHtml(expiryText)}</p>
          <p style="margin:28px 0">
            <a href="${escapeHtml(loginUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none;font-weight:700">Åpne Bidsite</a>
          </p>
        </div>
      `,
    },
  });
  const result = await poller.pollUntilDone();
  if (result.status !== "Succeeded") {
    return {
      delivered: false as const,
      reason: result.error?.message ?? "E-postleveringen feilet.",
    };
  }
  return { delivered: true as const, operationId: result.id };
}
