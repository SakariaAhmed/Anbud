import Link from "next/link";
import {
  BriefcaseBusiness,
  ExternalLink,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";

import {
  PROJECT_ROLE_LABELS,
  isProjectRole,
  strongestProjectRole,
  type ProjectRole,
} from "@/lib/access-control";
import type { PrincipalProfile } from "@/lib/server/access-control-repository";

const EYEBROW_CLASS =
  "text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-blue-800";

function formatDate(value: string | null, withTime = false) {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" } : {}),
  }).format(date);
}

type MergedProjectAccess = {
  id: string;
  name: string;
  role: ProjectRole | null;
  sources: string[];
};

function mergeProjectAccess(
  projects: PrincipalProfile["projects"],
): MergedProjectAccess[] {
  const byProject = new Map<string, MergedProjectAccess & { roles: ProjectRole[] }>();
  for (const entry of projects) {
    const current =
      byProject.get(entry.id) ??
      ({ id: entry.id, name: entry.name, roles: [], role: null, sources: [] } as
        MergedProjectAccess & { roles: ProjectRole[] });
    if (isProjectRole(entry.role)) current.roles.push(entry.role);
    const source =
      entry.source === "direct" ? "Direkte" : `Gruppe: ${entry.groupName ?? "Gruppe"}`;
    if (!current.sources.includes(source)) current.sources.push(source);
    byProject.set(entry.id, current);
  }
  return [...byProject.values()].map(({ roles, ...rest }) => ({
    ...rest,
    role: strongestProjectRole(roles),
  }));
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-3">
      <dt className="shrink-0 text-sm text-slate-500">{label}</dt>
      <dd className="truncate text-right text-sm font-semibold text-slate-900">
        {value}
      </dd>
    </div>
  );
}

function SectionCard({
  eyebrow,
  title,
  icon,
  children,
  delay,
}: {
  eyebrow: string;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  delay: number;
}) {
  return (
    <section
      className="profile-rise rounded-2xl border border-slate-200 bg-white shadow-sm"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-3 border-b border-slate-100 px-6 py-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-800">
          {icon}
        </span>
        <div>
          <p className={EYEBROW_CLASS}>{eyebrow}</p>
          <h2 className="font-serif text-lg font-semibold tracking-tight text-slate-900">
            {title}
          </h2>
        </div>
      </div>
      <div className="px-6 py-5">{children}</div>
    </section>
  );
}

export function ProfileView({
  profile,
  fallbackIdentityType,
  isAdmin,
}: {
  profile: PrincipalProfile | null;
  fallbackIdentityType: "internal" | "guest";
  isAdmin: boolean;
}) {
  const identityType = profile?.identityType ?? fallbackIdentityType;
  const displayName = profile?.displayName ?? "Bruker";
  const authMethod =
    profile?.authMethod ?? (identityType === "guest" ? "guest_code" : "entra");
  const accountTypeLabel =
    identityType === "guest"
      ? "Gjestekonto"
      : authMethod === "admin_password"
        ? "Administratorkonto (passord)"
        : "Microsoft-konto";
  const projects = mergeProjectAccess(profile?.projects ?? []);

  return (
    <div className="min-h-[calc(100vh-var(--app-header-height))] bg-background">
      <style>{`
        @keyframes profile-rise {
          from { opacity: 0; transform: translateY(14px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .profile-rise { animation: profile-rise 440ms cubic-bezier(0.16, 1, 0.3, 1) both; }
        @media (prefers-reduced-motion: reduce) { .profile-rise { animation: none; } }
      `}</style>

      <div className="mx-auto w-full max-w-5xl px-5 py-10 sm:px-8">
        <header className="profile-rise flex flex-wrap items-center gap-5">
          <span className="grid size-16 shrink-0 place-items-center rounded-2xl border border-blue-200 bg-blue-50 font-serif text-2xl font-bold uppercase text-blue-900">
            {displayName.charAt(0)}
          </span>
          <div className="min-w-0">
            <p className={EYEBROW_CLASS}>Min profil</p>
            <h1 className="truncate font-serif text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              {displayName}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700">
                {identityType === "guest" ? (
                  <KeyRound className="size-3.5 text-slate-500" />
                ) : (
                  <ShieldCheck className="size-3.5 text-slate-500" />
                )}
                {accountTypeLabel}
              </span>
              {isAdmin ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-xs font-semibold text-cyan-900">
                  <ShieldCheck className="size-3.5" />
                  Administrator
                </span>
              ) : null}
            </div>
          </div>
        </header>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="flex flex-col gap-6">
            <SectionCard
              eyebrow="Konto"
              title="Kontodetaljer"
              icon={<UserRound className="size-4" />}
              delay={60}
            >
              <dl className="divide-y divide-slate-100">
                <InfoRow label="Visningsnavn" value={displayName} />
                <InfoRow
                  label="Brukernavn (e-post)"
                  value={profile?.emailMasked ?? "–"}
                />
                <InfoRow label="Kontotype" value={accountTypeLabel} />
                <InfoRow
                  label="Sist innlogget"
                  value={formatDate(profile?.lastLoginAt ?? null, true)}
                />
                <InfoRow
                  label="Medlem siden"
                  value={formatDate(profile?.createdAt ?? null)}
                />
              </dl>
              <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
                Av personvernhensyn lagrer bidsite bare en maskert utgave av
                e-postadressen din.
              </p>
            </SectionCard>

            <SectionCard
              eyebrow="Sikkerhet"
              title="Passord og pålogging"
              icon={<LockKeyhole className="size-4" />}
              delay={140}
            >
              {authMethod === "guest_code" ? (
                <div className="space-y-3 text-sm leading-6 text-slate-600">
                  <p>
                    Du er logget inn med en personlig gjestekode. Gjestekontoer
                    har ikke passord.
                  </p>
                  <p>
                    Trenger du en ny kode, kontakter du prosjektansvarlig — den
                    gamle koden slutter da å virke.
                  </p>
                </div>
              ) : authMethod === "admin_password" ? (
                <div className="space-y-3 text-sm leading-6 text-slate-600">
                  <p>
                    Du er logget inn med det dedikerte administratorpassordet.
                    Det forvaltes utenfor applikasjonen og roteres av
                    driftsansvarlig.
                  </p>
                </div>
              ) : (
                <div className="space-y-4 text-sm leading-6 text-slate-600">
                  <p>
                    Kontoen din administreres av Microsoft. Passordbytte og
                    totrinnsbekreftelse gjør du hos Microsoft — endringene
                    gjelder umiddelbart i bidsite.
                  </p>
                  <div className="flex flex-wrap gap-2.5">
                    <a
                      href="https://mysignins.microsoft.com/security-info/password/change"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-900 px-4 text-sm font-semibold text-white transition-all duration-[180ms] hover:-translate-y-0.5 hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      <LockKeyhole className="size-4" />
                      Bytt passord hos Microsoft
                      <ExternalLink className="size-3.5 opacity-70" />
                    </a>
                    <a
                      href="https://myaccount.microsoft.com"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 transition-all duration-[180ms] hover:-translate-y-0.5 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      Administrer Microsoft-kontoen
                      <ExternalLink className="size-3.5 opacity-70" />
                    </a>
                  </div>
                </div>
              )}
            </SectionCard>
          </div>

          <div className="flex flex-col gap-6">
            <SectionCard
              eyebrow="Tilganger"
              title="Prosjekttilganger"
              icon={<BriefcaseBusiness className="size-4" />}
              delay={220}
            >
              {isAdmin ? (
                <p className="mb-4 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2.5 text-xs leading-5 text-cyan-900">
                  Som administrator har du i tillegg global lesetilgang og
                  tilgangsstyring for hele arbeidsområdet.
                </p>
              ) : null}
              {projects.length ? (
                <ul className="divide-y divide-slate-100">
                  {projects.map((project) => (
                    <li key={project.id}>
                      <Link
                        href={`/projects/${project.id}`}
                        className="group flex items-center justify-between gap-4 rounded-lg px-2 py-3 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-slate-900 group-hover:text-blue-900">
                            {project.name}
                          </span>
                          <span className="mt-0.5 block text-xs text-slate-500">
                            {project.sources.join(" · ")}
                          </span>
                        </span>
                        <span className="shrink-0 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-900">
                          {project.role
                            ? PROJECT_ROLE_LABELS[project.role]
                            : "Tilgang"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
                  Ingen prosjekttilganger registrert
                  {isAdmin ? " — du ser prosjekter via administratorrollen." : "."}
                </p>
              )}
            </SectionCard>

            <SectionCard
              eyebrow="Grupper"
              title="Gruppemedlemskap"
              icon={<Users className="size-4" />}
              delay={300}
            >
              {profile?.groups.length ? (
                <div className="flex flex-wrap gap-2">
                  {profile.groups.map((group) => (
                    <span
                      key={group.id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700"
                    >
                      <Users className="size-3.5 text-slate-500" />
                      {group.name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  Du er ikke medlem av noen grupper.
                </p>
              )}
            </SectionCard>
          </div>
        </div>
      </div>
    </div>
  );
}
