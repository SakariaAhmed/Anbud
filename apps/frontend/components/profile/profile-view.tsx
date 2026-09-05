import Link from "next/link";
import {
  ArrowUpRight,
  BriefcaseBusiness,
  LockKeyhole,
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

type ProjectAccess = {
  id: string;
  name: string;
  role: ProjectRole | null;
  sources: string[];
};

function formatDate(value: string | null, includeTime = false) {
  if (!value) return "Ikke registrert";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Ikke registrert";
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "medium",
    ...(includeTime ? { timeStyle: "short" } : {}),
  }).format(date);
}

function collectProjectAccess(
  entries: PrincipalProfile["projects"],
): ProjectAccess[] {
  const projects = new Map<
    string,
    Omit<ProjectAccess, "role"> & { roles: ProjectRole[] }
  >();

  for (const entry of entries) {
    const project = projects.get(entry.id) ?? {
      id: entry.id,
      name: entry.name,
      roles: [],
      sources: [],
    };
    if (isProjectRole(entry.role)) project.roles.push(entry.role);
    const source =
      entry.source === "direct"
        ? "Direkte tilgang"
        : `Via ${entry.groupName ?? "gruppe"}`;
    if (!project.sources.includes(source)) project.sources.push(source);
    projects.set(entry.id, project);
  }

  return [...projects.values()]
    .map(({ roles, ...project }) => ({
      ...project,
      role: strongestProjectRole(roles),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "nb"));
}

function Section({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-slate-200 pt-5">
      <header className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-slate-100 text-slate-700">
          {icon}
        </span>
        <div>
          <h2 className="text-base font-semibold text-slate-950">{title}</h2>
          <p className="mt-0.5 text-sm leading-5 text-slate-500">
            {description}
          </p>
        </div>
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-slate-100 py-3 last:border-0 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="break-words text-sm font-medium text-slate-900">{value}</dd>
    </div>
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
  const displayName = profile?.displayName?.trim() || "Bruker";
  const authMethod =
    profile?.authMethod ?? (identityType === "guest" ? "guest_code" : "entra");
  const accountLabel =
    identityType === "guest"
      ? "Gjestekonto"
      : authMethod === "admin_password"
        ? "Administratorkonto"
        : "Microsoft-konto";
  const projects = collectProjectAccess(profile?.projects ?? []);

  return (
    <div className="min-h-[calc(100vh-var(--app-header-height))] bg-slate-50">
      <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10">
        <header className="border-b border-slate-300 pb-6">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Konto og tilgang
          </p>
          <div className="mt-3">
            <div className="flex min-w-0 items-center gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-slate-900 text-lg font-semibold uppercase text-white">
                {displayName.charAt(0)}
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                  {displayName}
                </h1>
                <p className="mt-1 text-sm text-slate-600">
                  {profile?.emailMasked ?? accountLabel}
                </p>
              </div>
            </div>
          </div>
        </header>

        <div className="mt-7 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <div className="space-y-8">
            <Section
              title="Kontodetaljer"
              description="Identiteten som brukes i bidsite."
              icon={<UserRound className="size-4" />}
            >
              <dl>
                <Detail label="Visningsnavn" value={displayName} />
                <Detail
                  label="Brukernavn"
                  value={profile?.emailMasked ?? "Ikke registrert"}
                />
                <Detail label="Kontotype" value={accountLabel} />
                <Detail
                  label="Sist innlogget"
                  value={formatDate(profile?.lastLoginAt ?? null, true)}
                />
                <Detail
                  label="Opprettet"
                  value={formatDate(profile?.createdAt ?? null)}
                />
              </dl>
            </Section>

            <Section
              title="Pålogging og sikkerhet"
              description="Hvor legitimasjonen din administreres."
              icon={<LockKeyhole className="size-4" />}
            >
              {authMethod === "guest_code" ? (
                <p className="text-sm leading-6 text-slate-600">
                  Du logger inn med en personlig gjestekode. Kontakt
                  prosjektansvarlig dersom koden må erstattes; den gamle koden
                  blir da ugyldig.
                </p>
              ) : authMethod === "admin_password" ? (
                <p className="text-sm leading-6 text-slate-600">
                  Administratorpassordet forvaltes og roteres av
                  driftsansvarlig utenfor applikasjonen.
                </p>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm leading-6 text-slate-600">
                    Microsoft administrerer passord og flerfaktorautentisering
                    for kontoen din.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href="https://mysignins.microsoft.com/security-info/password/change"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      Bytt passord
                      <ArrowUpRight className="size-3.5" />
                    </a>
                    <a
                      href="https://myaccount.microsoft.com"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      Microsoft-konto
                      <ArrowUpRight className="size-3.5" />
                    </a>
                  </div>
                </div>
              )}
            </Section>
          </div>

          <div className="space-y-8">
            <Section
              title="Prosjekter"
              description="Din sterkeste rolle og hvordan tilgangen er gitt."
              icon={<BriefcaseBusiness className="size-4" />}
            >
              {isAdmin ? (
                <p className="mb-3 border-l-2 border-cyan-700 bg-cyan-50 px-3 py-2 text-xs leading-5 text-cyan-950">
                  Administratorrollen gir global lesetilgang og tilgang til
                  styringsfunksjoner.
                </p>
              ) : null}
              {projects.length ? (
                <ul className="divide-y divide-slate-200 border-y border-slate-200">
                  {projects.map((project) => (
                    <li key={project.id}>
                      <Link
                        href={`/projects/${project.id}`}
                        className="group grid gap-1 px-1 py-3.5 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-slate-950 group-hover:text-blue-800">
                            {project.name}
                          </span>
                          <span className="mt-0.5 block text-xs text-slate-500">
                            {project.sources.join(" · ")}
                          </span>
                        </span>
                        <span className="w-fit rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                          {project.role
                            ? PROJECT_ROLE_LABELS[project.role]
                            : "Tilgang"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="border-y border-dashed border-slate-300 py-5 text-sm text-slate-500">
                  Ingen direkte eller gruppebaserte prosjekttilganger er
                  registrert.
                </p>
              )}
            </Section>

            <Section
              title="Grupper"
              description="Gruppene som gir deg delte tilganger."
              icon={<Users className="size-4" />}
            >
              {profile?.groups.length ? (
                <ul className="flex flex-wrap gap-2">
                  {profile.groups.map((group) => (
                    <li
                      key={group.id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700"
                    >
                      <Users className="size-3.5 text-slate-500" />
                      {group.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">
                  Du er ikke medlem av noen grupper.
                </p>
              )}
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
