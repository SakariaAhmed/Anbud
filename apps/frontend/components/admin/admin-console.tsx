"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleUserRound,
  Copy, Eye, FileText, FolderKanban, KeyRound, LoaderCircle, LockKeyhole,
  LogIn, Plus, RotateCcw, Search, ShieldCheck, Trash2, UserPlus, Users, X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PROJECT_PAGE_LABELS } from "@/lib/project-page-activity";

type ShareableRole = "editor" | "viewer" | "restricted_viewer";
type UserProject = { id: string; name: string; role: ShareableRole | "owner"; source: "direct" };
type AdminUser = {
  id: string; identity_type: "internal" | "guest"; display_name: string;
  guest_description: string | null;
  email_masked: string | null; disabled_at: string | null; last_login_at: string | null;
  isAdmin: boolean; projectCount: number; projects: UserProject[];
  groups: Array<{ id: string; name: string }>;
  guestLogin: {
    active: boolean;
    lastFour: string;
    version: number;
    rotatedAt: string | null;
    lastUsedAt: string | null;
  } | null;
};
type GuestCodeReveal = {
  code: string;
  emailMasked: string;
  emailDelivered: boolean;
  emailReason?: string;
};
type AdminGroup = { id: string; name: string; description: string | null; memberCount: number; projectCount: number };
type GroupDetail = AdminGroup & {
  members: Array<{ id: string; display_name: string; identity_type: "internal" | "guest"; email_masked: string | null }>;
  projects: Array<{ project_id: string; projectName: string; role: ShareableRole }>;
};
type ProjectSummary = { id: string; name: string; customer_name: string | null; status: string; updated_at: string };
type ActivityEvent = {
  id: number; occurred_at: string; action: string; result: string; project_id: string | null;
  entity_type: string | null; entity_id: string | null;
  actor: { id: string; display_name: string; identity_type: "internal" | "guest"; email_masked: string | null } | null;
  project: { id: string; name: string } | null;
  metadata: { path?: string; method?: string; page?: string; pageLabel?: string } | null;
};
type ActivityPayload = { events: ActivityEvent[]; summary: { total: number; uniqueUsers: number; downloads: number; writes: number } };
type Section = "overview" | "people" | "groups" | "activity";

const ROLE_LABELS: Record<ShareableRole | "owner", string> = {
  owner: "Full tilgang",
  editor: "Kan redigere",
  viewer: "Lese og laste ned",
  restricted_viewer: "Kun lese",
};

const SELECT_CLASS =
  "h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-9 text-sm text-slate-900 outline-none transition-colors duration-180 focus:border-blue-900 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400";

const PRIMARY_BUTTON_CLASS =
  "bg-blue-900 text-white shadow-sm transition-all duration-180 hover:bg-blue-800 hover:shadow";

const EYEBROW_CLASS = "text-[0.68rem] font-semibold uppercase tracking-[0.14em]";

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Forespørselen feilet.");
  return payload;
}

export function AdminConsole() {
  const [section, setSection] = useState<Section>("overview");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activity, setActivity] = useState<ActivityPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [userData, groupData, activityData, projectData] = await Promise.all([
        readJson<{ users: AdminUser[] }>("/api/admin/users"),
        readJson<{ groups: AdminGroup[] }>("/api/admin/groups"),
        readJson<ActivityPayload>("/api/admin/activity?limit=300"),
        readJson<ProjectSummary[]>("/api/projects"),
      ]);
      setUsers(userData.users);
      setGroups(groupData.groups);
      setActivity(activityData);
      setProjects(projectData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Kunne ikke laste styringsdata.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const admin = users.find((user) => user.isAdmin) ?? null;
  const people = users.filter((user) => !user.isAdmin);
  const pageViewCount = (activity?.events ?? []).filter((event) => event.action === "page.view").length;

  return (
    <div className="min-h-[calc(100dvh-var(--app-header-height))] bg-slate-50 text-slate-950">
      <header className="border-b border-slate-300 bg-white">
        <div className="mx-auto max-w-[1480px] px-5 py-7 lg:px-10">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Global styring
          </p>
          <div className="mt-3">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
                Tilgang og innsikt
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Administrer personer, grupper og prosjekttilgang, og følg hvem
                som åpner, endrer, laster opp og laster ned.
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1480px] gap-8 px-5 py-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:px-10 lg:py-10">
        <aside>
          <nav className="grid gap-1.5 sm:grid-cols-4 lg:sticky lg:top-[calc(var(--app-header-height)+1.5rem)] lg:grid-cols-1">
            <NavButton
              active={section === "overview"}
              icon={<ShieldCheck />}
              label="Oversikt"
              detail="Status og siste lesing"
              onClick={() => setSection("overview")}
            />
            <NavButton
              active={section === "people"}
              icon={<CircleUserRound />}
              label="Personer og tilgang"
              detail={people.length === 1 ? "1 bruker" : `${people.length} brukere`}
              onClick={() => setSection("people")}
            />
            <NavButton
              active={section === "groups"}
              icon={<Users />}
              label="Grupper"
              detail={groups.length === 1 ? "1 gruppe" : `${groups.length} grupper`}
              onClick={() => setSection("groups")}
            />
            <NavButton
              active={section === "activity"}
              icon={<Activity />}
              label="Aktivitet"
              detail={pageViewCount === 1 ? "1 sidevisning" : `${pageViewCount} sidevisninger`}
              onClick={() => setSection("activity")}
            />
          </nav>
        </aside>

        <main className="min-w-0">
          {error ? (
            <div className="mb-6 flex items-start justify-between gap-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => setError("")}
                aria-label="Lukk"
                className="rounded-md p-0.5 transition-colors duration-180 hover:bg-rose-100"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : null}
          {loading ? <LoadingPanel /> : null}
          {!loading && section === "overview" && activity ? (
            <OverviewSection admin={admin} users={people} groups={groups} projects={projects} activity={activity} onNavigate={setSection} />
          ) : null}
          {!loading && section === "people" ? (
            <PeopleSection admin={admin} users={people} groups={groups} projects={projects} onReload={load} />
          ) : null}
          {!loading && section === "groups" ? (
            <GroupsSection groups={groups} users={people} projects={projects} onReload={load} />
          ) : null}
          {!loading && section === "activity" && activity ? <ActivitySection payload={activity} /> : null}
        </main>
      </div>
    </div>
  );
}

function LoadingPanel() {
  return (
    <div className="grid min-h-[28rem] place-items-center rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="text-center">
        <LoaderCircle className="mx-auto size-6 animate-spin text-blue-900" />
        <p className="mt-3 text-sm text-slate-500">Henter tilgangsbildet…</p>
      </div>
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: {
  active: boolean; icon: React.ReactNode; label: string; detail?: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-semibold transition-colors ${
        active
          ? "bg-slate-900 text-white shadow-sm"
          : "text-slate-600 hover:bg-white hover:text-slate-950"
      } [&_svg]:size-4`}
    >
      {icon}
      {label}
    </button>
  );
}

function OverviewSection({ admin, users, groups, projects, activity, onNavigate }: {
  admin: AdminUser | null; users: AdminUser[]; groups: AdminGroup[]; projects: ProjectSummary[];
  activity: ActivityPayload; onNavigate: (section: Section) => void;
}) {
  const pageViews = activity.events.filter((event) => event.action === "page.view");
  const readers = new Set(pageViews.map((event) => event.actor?.id).filter(Boolean));

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Administratorer" value="1" detail="Fast og låst rolle" icon={LockKeyhole} tone="cyan" />
        <Metric label="Brukere" value={users.length} detail={`${users.filter((user) => user.identity_type === "guest").length} gjester`} icon={CircleUserRound} />
        <Metric label="Prosjekter" value={projects.length} detail={`${groups.length} tilgangsgrupper`} icon={FolderKanban} />
        <Metric label="Aktive lesere" value={readers.size} detail={`${pageViews.length} registrerte sidevisninger`} icon={Eye} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,.8fr)]">
        <section className="self-start overflow-hidden border border-slate-200 bg-white">
          <SectionHeader
            eyebrow="Lesemønster"
            title="Sist leste sider"
            description="Prosjekt, side, bruker og tidspunkt – samlet i ett lesbart spor."
            action={
              <button
                type="button"
                onClick={() => onNavigate("activity")}
                className="flex items-center gap-1 text-xs font-semibold text-blue-900 transition-colors duration-180 hover:text-blue-700"
              >
                Se all aktivitet <ArrowRight className="size-3.5" />
              </button>
            }
          />
          <div className="divide-y divide-slate-100">
            {pageViews.slice(0, 7).map((event) => (
              <div key={event.id} className="grid gap-3 px-5 py-4 transition-colors duration-180 hover:bg-slate-50/70 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-cyan-50 text-cyan-800">
                    <FileText className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{activityPageLabel(event)}</p>
                    <p className="truncate text-xs text-slate-500">{event.project?.name ?? "Uten prosjekt"}</p>
                  </div>
                </div>
                <p className="truncate text-xs font-medium text-slate-600">{event.actor?.display_name ?? "System"}</p>
                <p className="whitespace-nowrap text-xs text-slate-400">{formatRelativeTime(event.occurred_at)}</p>
              </div>
            ))}
            {!pageViews.length ? (
              <EmptyState icon={Eye} text="Sidevisninger blir synlige her når brukere åpner prosjektfaner." />
            ) : null}
          </div>
        </section>

        <div className="space-y-4">
          <section className="border border-slate-200 bg-white p-6">
            <div className="flex items-start gap-4">
              <span className="grid size-11 place-items-center rounded-xl bg-slate-950 text-cyan-300">
                <ShieldCheck className="size-5" />
              </span>
            </div>
            <h2 className="mt-5 text-xl font-semibold tracking-tight">Én administrator</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Rollen tilhører bare {admin?.display_name ?? "Administrator"} og kan ikke tildeles fra brukerlisten. Andre får avgrenset prosjekttilgang.
            </p>
            <div className="mt-5 flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
              <Avatar name={admin?.display_name ?? "Administrator"} admin />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{admin?.display_name ?? "Administrator"}</p>
                <p className="text-xs text-slate-500">Global lesing og tilgangsstyring</p>
              </div>
            </div>
          </section>

          <button
            type="button"
            onClick={() => onNavigate("people")}
            className="group flex w-full items-center justify-between border border-blue-900 bg-blue-900 p-6 text-left text-white transition-colors duration-180 hover:bg-blue-800"
          >
            <span>
              <span className={`block ${EYEBROW_CLASS} text-cyan-300`}>Neste handling</span>
              <span className="mt-1.5 block text-lg font-semibold tracking-tight">Inviter en bruker</span>
              <span className="mt-1 block text-xs text-blue-100">Velg prosjekt, rolle og gruppe i samme flyt.</span>
            </span>
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10">
              <ArrowUpRight className="size-4 transition-transform duration-180 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, detail, icon: Icon, tone = "blue" }: {
  label: string; value: string | number; detail: string; icon: typeof Activity; tone?: "blue" | "cyan";
}) {
  return (
    <div className="border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <p className={`${EYEBROW_CLASS} text-slate-500`}>{label}</p>
        <span className={`grid size-8 place-items-center rounded-lg ${tone === "cyan" ? "bg-cyan-50 text-cyan-800" : "bg-blue-50 text-blue-900"}`}>
          <Icon className="size-4" />
        </span>
      </div>
      <p className="mt-4 text-3xl font-bold tracking-tight tabular-nums">{value}</p>
      <p className="mt-1.5 text-xs text-slate-500">{detail}</p>
    </div>
  );
}

function PeopleSection({ admin, users, groups, projects, onReload }: {
  admin: AdminUser | null; users: AdminUser[]; groups: AdminGroup[]; projects: ProjectSummary[];
  onReload: () => Promise<void>;
}) {
  const [showInvite, setShowInvite] = useState(false);
  const [query, setQuery] = useState("");
  const visibleUsers = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("nb-NO");
    return users.filter((user) =>
      !term ||
      [user.display_name, user.email_masked, ...user.projects.map((project) => project.name)]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase("nb-NO").includes(term)),
    );
  }, [query, users]);

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Mennesker og tilgang"
        title="Personer"
        description="Inviter nye personer og se eller endre tilgangen deres direkte."
        action={
          <Button className={PRIMARY_BUTTON_CLASS} onClick={() => setShowInvite((value) => !value)}>
            {showInvite ? <X /> : <UserPlus />}
            {showInvite ? "Lukk" : "Gi tilgang"}
          </Button>
        }
      />
      {showInvite ? (
        <InviteUserPanel
          groups={groups}
          projects={projects}
          onCreated={onReload}
        />
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50/60 px-5 py-4">
          <div className="flex items-center gap-3">
            <Avatar name={admin?.display_name ?? "Administrator"} admin />
            <div>
              <p className="text-sm font-semibold">{admin?.display_name ?? "Administrator"}</p>
              <p className="text-xs text-slate-500">Systemets eneste administrator</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
            <LockKeyhole className="size-3.5" /> Rollen kan ikke endres
          </div>
        </div>
        <div className="border-b border-slate-200 px-5 py-3">
          <label className="relative block max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Søk bruker eller prosjekt"
              className="bg-white pl-9"
            />
          </label>
        </div>
        <div className="divide-y divide-slate-100">
          {visibleUsers.map((user) => (
            <UserAccessRow key={user.id} user={user} projects={projects} onReload={onReload} />
          ))}
          {!visibleUsers.length ? <EmptyState icon={CircleUserRound} text="Ingen brukere samsvarer med søket." /> : null}
        </div>
      </section>
    </div>
  );
}

function InviteUserPanel({ groups, projects, onCreated }: {
  groups: AdminGroup[]; projects: ProjectSummary[]; onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [guestDescription, setGuestDescription] = useState("");
  const [email, setEmail] = useState("");
  const [projectGrants, setProjectGrants] = useState<Record<string, ShareableRole | "">>({});
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [guestCode, setGuestCode] = useState<GuestCodeReveal | null>(null);
  const selectedProjects = projects.filter((project) => project.id in projectGrants);
  const availableProjects = projects.filter((project) => !(project.id in projectGrants));
  const hasProjectWithoutRole = Object.values(projectGrants).some((role) => !role);

  async function submit() {
    setBusy(true);
    setError("");
    setNotice("");
    setGuestCode(null);
    try {
      const result = await readJson<{
        identityType: "internal" | "guest";
        guestCode: string | null;
        email: string;
        emailDelivery: { delivered: boolean; reason?: string };
      }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email,
          displayName: name,
          guestDescription,
          projectGrants: Object.entries(projectGrants).flatMap(([projectId, role]) =>
            role ? [{ projectId, role }] : [],
          ),
          groupIds,
        }),
      });
      if (result.identityType === "guest" && result.guestCode) {
        setGuestCode({
          code: result.guestCode,
          emailMasked: result.email,
          emailDelivered: result.emailDelivery.delivered,
          emailReason: result.emailDelivery.reason,
        });
      } else {
        setNotice(
          result.identityType === "internal"
            ? "Brukeren er lagt til og logger inn med Microsoft-kontoen sin."
            : "Gjestebrukeren er lagt til med sin eksisterende innloggingskode.",
        );
      }
      setName("");
      setGuestDescription("");
      setEmail("");
      setGroupIds([]);
      setProjectGrants({});
      await onCreated();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Kunne ikke invitere brukeren.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !busy &&
          name.trim().length >= 2 &&
          guestDescription.trim().length >= 3 &&
          email.trim() &&
          Object.keys(projectGrants).length > 0 &&
          !hasProjectWithoutRole
        ) {
          void submit();
        }
      }}
      className="border border-blue-200 bg-white p-6"
    >
      <div className="flex items-start gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue-900 text-white">
          <UserPlus className="size-5" />
        </span>
        <div>
          <h3 className="text-xl font-semibold tracking-tight">Inviter og gi tilgang</h3>
          <p className="mt-1 text-sm text-slate-500">Velg person, ett eller flere prosjekter og tilgangsnivå per prosjekt. Alt sendes i én invitasjon.</p>
        </div>
      </div>

      {error ? <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p> : null}
      {guestCode ? <GuestCodePanel value={guestCode} /> : null}
      {notice ? (
        <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {notice}
        </p>
      ) : null}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Field label="Navn" htmlFor="invite-name">
          <Input
            id="invite-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ola Nordmann"
            minLength={2}
            maxLength={120}
            required
          />
        </Field>
        <Field label="E-post" htmlFor="invite-email">
          <Input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ola@firma.no" maxLength={320} required />
        </Field>
      </div>

      <div className="mt-6 border-t border-slate-200 pt-5">
        <div>
          <Label htmlFor="invite-add-project">Prosjekter og tilgang</Label>
          <p className="mt-1 text-xs text-slate-500">Legg til ett prosjekt om gangen. Tilgangen aktiveres først når du velger en rolle.</p>
        </div>
        <div className="mt-3 max-w-3xl">
          <NativeSelect
            id="invite-add-project"
            value=""
            disabled={!availableProjects.length}
            onChange={(projectId) => {
              if (!projectId) return;
              setProjectGrants((current) => ({ ...current, [projectId]: "" }));
            }}
            options={availableProjects.map((project) => ({
              value: project.id,
              label: project.name,
            }))}
            placeholder={availableProjects.length ? "Velg et prosjekt som skal legges til" : "Ingen flere prosjekter tilgjengelig"}
          />
        </div>

        {selectedProjects.length ? (
          <div className="mt-3 space-y-2">
            {selectedProjects.map((project) => {
              const selectedRole = projectGrants[project.id];
              return (
                <div
                  key={project.id}
                  className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border px-3 py-3 transition-colors sm:grid-cols-[minmax(0,1fr)_12rem_auto] ${
                    selectedRole ? "border-blue-200 bg-blue-50" : "border-amber-300 bg-amber-50"
                  }`}
                >
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-slate-800">{project.name}</span>
                    {project.customer_name ? (
                      <span className="mt-0.5 block truncate text-xs text-slate-500">{project.customer_name}</span>
                    ) : null}
                    {!selectedRole ? (
                      <span className="mt-1 block text-[0.68rem] font-semibold text-amber-800">Velg rolle for å aktivere tilgangen</span>
                    ) : null}
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <RoleSelect
                      id={`invite-project-role-${project.id}`}
                      value={selectedRole ?? ""}
                      placeholder="Velg rolle"
                      compact
                      onChange={(nextRole) => setProjectGrants((current) => ({
                        ...current,
                        [project.id]: nextRole,
                      }))}
                    />
                  </div>
                  <button
                    type="button"
                    aria-label={`Fjern ${project.name}`}
                    title="Fjern prosjekt"
                    onClick={() => setProjectGrants((current) => {
                      const next = { ...current };
                      delete next[project.id];
                      return next;
                    })}
                    className="col-start-2 row-start-1 grid size-8 place-items-center text-slate-400 transition-colors hover:bg-white hover:text-rose-700 sm:col-start-auto sm:row-start-auto"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 border border-dashed border-slate-300 px-4 py-5 text-center text-sm text-slate-500">
            Ingen prosjekttilgang lagt til ennå.
          </p>
        )}
      </div>

      <div className="mt-5 max-w-3xl">
        <Field label="Hvorfor trenger personen tilgang?" htmlFor="invite-description">
          <Textarea
            id="invite-description"
            value={guestDescription}
            onChange={(event) => setGuestDescription(event.target.value)}
            placeholder="For eksempel: Ekstern løsningsarkitekt fra samarbeidspartner"
            minLength={3}
            maxLength={240}
            rows={3}
            required
          />
          <p className="mt-1 text-right text-[0.68rem] text-slate-400">
            {guestDescription.length}/240 tegn
          </p>
        </Field>
      </div>

      {groups.length ? (
        <div className="mt-5">
          <Label>
            Legg også i grupper <span className="font-normal text-slate-400">(valgfritt)</span>
          </Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {groups.map((group) => {
              const checked = groupIds.includes(group.id);
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => setGroupIds((current) => checked ? current.filter((id) => id !== group.id) : [...current, group.id])}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all duration-180 ${
                    checked
                      ? "border-blue-900 bg-blue-900 text-white"
                      : "border-slate-300 bg-white text-slate-600 hover:border-blue-400 hover:text-blue-900"
                  }`}
                >
                  {checked ? <Check className="size-3" /> : <Plus className="size-3" />}
                  {group.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-6 flex justify-end border-t border-slate-100 pt-5">
        <Button
          type="submit"
          className={PRIMARY_BUTTON_CLASS}
          disabled={
            busy ||
            name.trim().length < 2 ||
            guestDescription.trim().length < 3 ||
            !email.trim() ||
            Object.keys(projectGrants).length === 0 ||
            hasProjectWithoutRole
          }
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <UserPlus />}
          Inviter og gi tilgang
        </Button>
      </div>
    </form>
  );
}

function UserAccessRow({ user, projects, onReload }: {
  user: AdminUser; projects: ProjectSummary[]; onReload: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [draftProjectRoles, setDraftProjectRoles] = useState<Record<string, ShareableRole>>({});
  const [projectId, setProjectId] = useState("");
  const [role, setRole] = useState<ShareableRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [guestCode, setGuestCode] = useState<GuestCodeReveal | null>(null);

  async function saveAccess(targetProjectId = projectId, targetRole = role) {
    if (!targetProjectId) return;
    const currentProject = user.projects.find((project) => project.id === targetProjectId);
    if (
      currentProject?.role === "owner" &&
      !window.confirm(
        `Endre ${user.display_name} fra prosjekteier til «${ROLE_LABELS[targetRole]}» i ${currentProject.name}? Prosjektet blir uten prosjekteier.`,
      )
    ) return;
    setBusy(true);
    setError("");
    try {
      await readJson(`/api/admin/users/${user.id}/access`, {
        method: "PATCH",
        body: JSON.stringify({ projectId: targetProjectId, role: targetRole }),
      });
      setProjectId("");
      await onReload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Kunne ikke lagre tilgangen.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(project: UserProject) {
    const ownerWarning = project.role === "owner"
      ? " Personen er prosjekteier, og prosjektet blir uten prosjekteier."
      : "";
    if (!window.confirm(`Fjerne ${user.display_name} fra ${project.name}?${ownerWarning}`)) return;
    setBusy(true);
    setError("");
    try {
      await readJson(`/api/admin/users/${user.id}/access`, {
        method: "DELETE",
        body: JSON.stringify({ projectId: project.id }),
      });
      await onReload();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Kunne ikke fjerne tilgangen.");
    } finally {
      setBusy(false);
    }
  }

  async function rotateGuestLogin() {
    setBusy(true);
    setError("");
    setGuestCode(null);
    try {
      const result = await readJson<{
        code: string;
        emailMasked: string;
        emailDelivery: { delivered: boolean; reason?: string } | null;
      }>(`/api/admin/users/${user.id}/guest-login`, { method: "POST" });
      setGuestCode({
        code: result.code,
        emailMasked: result.emailMasked,
        emailDelivered: result.emailDelivery?.delivered ?? false,
        emailReason: result.emailDelivery?.reason,
      });
      await onReload();
    } catch (rotateError) {
      setError(
        rotateError instanceof Error
          ? rotateError.message
          : "Kunne ikke opprette ny gjestekode.",
      );
    } finally {
      setBusy(false);
    }
  }

  function toggleProjectAccess(project: UserProject) {
    setExpandedProjectId((current) => current === project.id ? null : project.id);
    setDraftProjectRoles((current) => ({
      ...current,
      [project.id]: current[project.id] ?? (project.role === "owner" ? "editor" : project.role),
    }));
  }

  return (
    <div className="px-5 py-4 transition-colors duration-180 hover:bg-slate-50/50">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center gap-4 text-left">
        <Avatar name={user.display_name} guest={user.identity_type === "guest"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold">{user.display_name}</p>
            {user.identity_type === "guest" ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.1em] text-amber-800">
                Gjest
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-slate-500">{user.email_masked ?? "E-post ikke tilgjengelig"}</p>
          {user.identity_type === "guest" ? (
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">
              {user.guest_description ?? "Ingen gjestebeskrivelse registrert."}
            </p>
          ) : null}
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          {user.groups.slice(0, 2).map((group) => (
            <span key={group.id} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[0.68rem] font-medium text-slate-600">
              {group.name}
            </span>
          ))}
        </div>
        <div className="w-24 text-right">
          <p className="text-sm font-semibold tabular-nums">{user.projectCount}</p>
          <p className="text-[0.65rem] text-slate-500">prosjekter</p>
        </div>
        <ChevronDown className={`size-4 text-slate-400 transition-transform duration-180 ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded ? (
        <div className="ml-14 mt-4 border-t border-slate-100 pt-4">
          {error ? <p className="mb-3 text-sm text-rose-700">{error}</p> : null}
          {user.identity_type === "guest" ? (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-800">
                    <LogIn className="size-4" />
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-amber-950">Gjestinnlogging</p>
                      <span className={`rounded-full px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.1em] ${
                        user.guestLogin?.active
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-slate-200 text-slate-600"
                      }`}>
                        {user.guestLogin?.active ? "Aktiv" : "Ikke aktiv"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-amber-800">
                      {user.guestLogin
                        ? `Kodeversjon ${user.guestLogin.version} · slutter på ${user.guestLogin.lastFour}`
                        : "Ingen gjestekode er registrert."}
                      {user.guestLogin?.lastUsedAt
                        ? ` · sist brukt ${formatDateTime(user.guestLogin.lastUsedAt)}`
                        : ""}
                    </p>
                    <p className="mt-1 text-[0.68rem] text-amber-700">
                      En ny kode erstatter den gamle og logger ut aktive gjesteøkter.
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !user.projects.length}
                  onClick={() => void rotateGuestLogin()}
                  className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
                >
                  {busy ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
                  {user.guestLogin ? "Lag ny kode" : "Opprett kode"}
                </Button>
              </div>
              {!user.projects.length ? (
                <p className="mt-3 text-xs text-amber-800">
                  Gi brukeren direkte tilgang til minst ett prosjekt før innlogging aktiveres.
                </p>
              ) : null}
            </div>
          ) : null}
          {guestCode ? <GuestCodePanel value={guestCode} /> : null}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,.85fr)]">
            <div>
              <p className={`${EYEBROW_CLASS} text-slate-500`}>Direkte prosjekttilgang</p>
              <div className="mt-2 space-y-2">
                {user.projects.map((project) => {
                  const projectExpanded = expandedProjectId === project.id;
                  const draftRole = draftProjectRoles[project.id] ?? (project.role === "owner" ? "editor" : project.role);
                  return (
                    <div
                      key={project.id}
                      className={`overflow-hidden rounded-xl border transition-colors duration-180 ${
                        projectExpanded
                          ? "border-blue-300 bg-white shadow-sm"
                          : "border-slate-200 bg-slate-50 hover:border-slate-300 hover:bg-white"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleProjectAccess(project)}
                        aria-expanded={projectExpanded}
                        aria-controls={`project-access-${user.id}-${project.id}`}
                        className="flex w-full items-center gap-3 px-3 py-3 text-left sm:px-4"
                      >
                        <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${projectExpanded ? "bg-blue-900 text-white" : "bg-blue-50 text-blue-900"}`}>
                          <FolderKanban className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[0.6rem] font-semibold uppercase tracking-[0.12em] text-blue-900">
                            {ROLE_LABELS[project.role]}
                          </span>
                          <span className="mt-0.5 block truncate text-xs font-semibold text-slate-900 sm:text-sm">
                            {project.name}
                          </span>
                        </span>
                        <span className="shrink-0 text-[0.68rem] font-semibold text-slate-500 sm:text-xs">
                          Rediger
                        </span>
                        <ChevronDown className={`size-4 shrink-0 text-slate-400 transition-transform duration-180 ${projectExpanded ? "rotate-180" : ""}`} />
                      </button>

                      {projectExpanded ? (
                        <div
                          id={`project-access-${user.id}-${project.id}`}
                          className="border-t border-slate-200 bg-white px-4 py-4 sm:px-5"
                        >
                          {project.role === "owner" ? (
                            <div className="mb-4 flex items-start gap-3 border border-amber-200 bg-amber-50 p-3 text-amber-950">
                              <LockKeyhole className="mt-0.5 size-4 shrink-0 text-amber-700" />
                              <div>
                                <p className="text-xs font-semibold">Denne personen er prosjekteier</p>
                                <p className="mt-1 text-xs leading-5 text-amber-800">
                                  Ved endring eller fjerning blir prosjektet uten prosjekteier. Administrator kan fortsatt styre tilgangen.
                                </p>
                              </div>
                            </div>
                          ) : null}
                          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                            <div>
                              <Label htmlFor={`project-role-${user.id}-${project.id}`}>Tilgangsnivå</Label>
                              <div className="mt-2 max-w-sm">
                                <RoleSelect
                                  id={`project-role-${user.id}-${project.id}`}
                                  value={draftRole}
                                  disabled={busy}
                                  onChange={(nextRole) => setDraftProjectRoles((current) => ({ ...current, [project.id]: nextRole }))}
                                />
                              </div>
                              <p className="mt-2 text-xs leading-5 text-slate-500">{roleDescription(draftRole)}</p>
                            </div>
                            <div className="flex flex-col-reverse gap-2 sm:flex-row">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => void revoke(project)}
                                className="border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                              >
                                <Trash2 /> Fjern tilgang
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                disabled={busy || (project.role !== "owner" && draftRole === project.role)}
                                onClick={() => void saveAccess(project.id, draftRole)}
                                className={PRIMARY_BUTTON_CLASS}
                              >
                                {busy ? <LoaderCircle className="animate-spin" /> : <Check />}
                                Lagre endring
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {!user.projects.length ? (
                  <p className="rounded-lg border border-dashed border-slate-200 p-3 text-xs text-slate-500">
                    Ingen direkte prosjektroller. Tilgang kan fortsatt komme fra en gruppe.
                  </p>
                ) : null}
              </div>
              {user.groups.length ? (
                <p className="mt-3 text-xs text-slate-500">Grupper: {user.groups.map((group) => group.name).join(", ")}</p>
              ) : null}
            </div>

            <form
              onSubmit={(event) => { event.preventDefault(); if (!busy && projectId) void saveAccess(); }}
              className="self-start rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <p className="text-sm font-semibold">Legg til eller endre tilgang</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
                <NativeSelect
                  value={projectId}
                  onChange={setProjectId}
                  options={projects.map((project) => ({ value: project.id, label: project.name }))}
                  placeholder="Velg prosjekt"
                />
                <RoleSelect value={role} onChange={setRole} />
                <Button type="submit" size="sm" className={PRIMARY_BUTTON_CLASS} disabled={!projectId || busy}>
                  {busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
                  Lagre
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GroupsSection({ groups, users, projects, onReload }: {
  groups: AdminGroup[]; users: AdminUser[]; projects: ProjectSummary[]; onReload: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [projectGrants, setProjectGrants] = useState<Record<string, ShareableRole>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      await readJson("/api/admin/groups", {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          principalIds: selectedMembers,
          projectGrants: Object.entries(projectGrants).map(([projectId, role]) => ({ projectId, role })),
        }),
      });
      setName("");
      setDescription("");
      setSelectedMembers([]);
      setProjectGrants({});
      setShowCreate(false);
      await onReload();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Kunne ikke opprette gruppen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Samlet tilgang"
        title="Grupper"
        description="Opprett gruppen med medlemmer og prosjekttilgang i samme flyt."
        action={
          <Button className={PRIMARY_BUTTON_CLASS} onClick={() => setShowCreate((value) => !value)}>
            {showCreate ? <X /> : <Plus />}
            {showCreate ? "Lukk" : "Ny gruppe"}
          </Button>
        }
      />

      {showCreate ? (
        <form
          onSubmit={(event) => { event.preventDefault(); if (!busy && name.trim().length >= 2) void create(); }}
          className="border border-blue-200 bg-white p-6"
        >
          <div className="grid gap-4 md:grid-cols-[1fr_1.5fr_auto] md:items-end">
            <Field label="Gruppenavn" htmlFor="group-name">
              <Input id="group-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Fagteam øst" />
            </Field>
            <Field label="Beskrivelse" htmlFor="group-description">
              <Input id="group-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Hvem gruppen er for" />
            </Field>
            <Button type="submit" className={PRIMARY_BUTTON_CLASS} disabled={busy || name.trim().length < 2}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Plus />}
              Opprett gruppe
            </Button>
          </div>
          <div className="mt-6 grid gap-6 border-t border-slate-200 pt-6 xl:grid-cols-2">
            <div>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className={`${EYEBROW_CLASS} text-slate-500`}>1. Medlemmer</p>
                  <p className="mt-1 text-xs text-slate-500">Velg hvem som skal være med i gruppen.</p>
                </div>
                <span className="text-xs font-semibold text-blue-900">{selectedMembers.length} valgt</span>
              </div>
              <div className="mt-3 grid max-h-56 gap-1 overflow-y-auto border border-slate-200 p-2 sm:grid-cols-2">
                {users.map((user) => {
                  const checked = selectedMembers.includes(user.id);
                  return (
                    <label key={user.id} className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-xs ${checked ? "bg-blue-50 text-blue-950" : "hover:bg-slate-50"}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => setSelectedMembers((current) => event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id))}
                        className="size-3.5 rounded border-slate-300 accent-blue-900"
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{user.display_name}</span>
                      {user.identity_type === "guest" ? <span className="text-[0.6rem] uppercase text-amber-700">Gjest</span> : null}
                    </label>
                  );
                })}
                {!users.length ? <p className="col-span-full p-3 text-center text-xs text-slate-500">Ingen personer er tilgjengelige ennå.</p> : null}
              </div>
            </div>
            <div>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className={`${EYEBROW_CLASS} text-slate-500`}>2. Prosjekttilgang</p>
                  <p className="mt-1 text-xs text-slate-500">Velg prosjekter og hva gruppen skal kunne gjøre.</p>
                </div>
                <span className="text-xs font-semibold text-blue-900">{Object.keys(projectGrants).length} valgt</span>
              </div>
              <div className="mt-3 max-h-56 space-y-1 overflow-y-auto border border-slate-200 p-2">
                {projects.map((project) => {
                  const selectedRole = projectGrants[project.id];
                  return (
                    <div key={project.id} className={`grid grid-cols-[auto_minmax(0,1fr)_9.5rem] items-center gap-2 rounded-md px-2.5 py-2 ${selectedRole ? "bg-blue-50" : "hover:bg-slate-50"}`}>
                      <input
                        type="checkbox"
                        checked={Boolean(selectedRole)}
                        onChange={(event) => setProjectGrants((current) => {
                          const next = { ...current };
                          if (event.target.checked) next[project.id] = "viewer";
                          else delete next[project.id];
                          return next;
                        })}
                        className="size-3.5 rounded border-slate-300 accent-blue-900"
                      />
                      <span className="truncate text-xs font-medium text-slate-700">{project.name}</span>
                      <RoleSelect
                        value={selectedRole ?? "viewer"}
                        disabled={!selectedRole}
                        compact
                        onChange={(nextRole) => setProjectGrants((current) => ({ ...current, [project.id]: nextRole }))}
                      />
                    </div>
                  );
                })}
                {!projects.length ? <p className="p-3 text-center text-xs text-slate-500">Ingen prosjekter er tilgjengelige.</p> : null}
              </div>
            </div>
          </div>
          {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        </form>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        {groups.map((group) => (
          <GroupPanel key={group.id} group={group} users={users} projects={projects} onReload={onReload} />
        ))}
      </div>
      {!groups.length ? (
        <section className="rounded-2xl border border-dashed border-slate-300 bg-white">
          <EmptyState icon={Users} text="Ingen grupper ennå. Opprett den første gruppen for å samle tilganger." />
        </section>
      ) : null}
    </div>
  );
}

function GroupPanel({ group, users, projects, onReload }: {
  group: AdminGroup; users: AdminUser[]; projects: ProjectSummary[]; onReload: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [projectGrants, setProjectGrants] = useState<Record<string, ShareableRole>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function loadDetail(force = false) {
    if (detail && !force) return;
    setLoading(true);
    setError("");
    try {
      const payload = await readJson<GroupDetail>(`/api/admin/groups/${group.id}`);
      setDetail(payload);
      setSelectedMembers(payload.members.map((member) => member.id));
      setProjectGrants(Object.fromEntries(payload.projects.map((project) => [project.project_id, project.role])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Kunne ikke hente gruppen.");
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      await readJson(`/api/admin/groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          principalIds: selectedMembers,
          projectGrants: Object.entries(projectGrants).map(([projectId, role]) => ({ projectId, role })),
        }),
      });
      await loadDetail(true);
      await onReload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Kunne ikke lagre gruppen.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Slette gruppen «${group.name}»? Medlemmer slettes ikke, men gruppetilgangene fjernes.`)) return;
    setSaving(true);
    setError("");
    try {
      await readJson(`/api/admin/groups/${group.id}`, { method: "DELETE" });
      await onReload();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Kunne ikke slette gruppen.");
      setSaving(false);
    }
  }

  return (
    <section className="self-start overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-all duration-180 hover:-translate-y-0.5 hover:shadow-md">
      <button
        type="button"
        onClick={() => { setExpanded((value) => !value); void loadDetail(); }}
        className="flex w-full items-start gap-4 p-5 text-left"
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-cyan-50 text-cyan-800">
          <Users className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-serif text-lg font-semibold tracking-tight">{group.name}</h3>
          <p className="mt-1 line-clamp-2 min-h-10 text-sm leading-5 text-slate-500">{group.description || "Ingen beskrivelse"}</p>
          <div className="mt-3 flex gap-3 text-[0.68rem] font-semibold text-slate-500">
            <span>{group.memberCount} medlemmer</span>
            <span aria-hidden>·</span>
            <span>{group.projectCount} prosjekter</span>
          </div>
        </div>
        <ChevronDown className={`mt-1 size-4 text-slate-400 transition-transform duration-180 ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded ? (
        <div className="border-t border-slate-200 bg-slate-50/60 p-5">
          {loading ? <LoaderCircle className="mx-auto size-5 animate-spin text-blue-900" /> : null}
          {error ? <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p> : null}
          {!loading && detail ? (
            <form onSubmit={(event) => { event.preventDefault(); if (!saving) void save(); }} className="space-y-5">
              <div>
                <p className={`${EYEBROW_CLASS} text-slate-500`}>Medlemmer</p>
                <div className="mt-2 grid max-h-44 gap-1 overflow-y-auto sm:grid-cols-2">
                  {users.map((user) => {
                    const checked = selectedMembers.includes(user.id);
                    return (
                      <label
                        key={user.id}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors duration-180 ${
                          checked
                            ? "border-blue-200 bg-blue-50 text-blue-950"
                            : "border-transparent bg-white text-slate-600 hover:border-slate-200"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) =>
                            setSelectedMembers((current) =>
                              event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id),
                            )
                          }
                          className="size-3.5 rounded border-slate-300 accent-blue-900"
                        />
                        <span className="min-w-0 flex-1 truncate font-medium">{user.display_name}</span>
                        {user.identity_type === "guest" ? (
                          <span className="text-[0.6rem] uppercase text-amber-700">Gjest</span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className={`${EYEBROW_CLASS} text-slate-500`}>Prosjekttilganger</p>
                <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
                  {projects.map((project) => {
                    const role = projectGrants[project.id];
                    return (
                      <div
                        key={project.id}
                        className={`grid grid-cols-[auto_minmax(0,1fr)_9.5rem] items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors duration-180 ${
                          role ? "border-blue-200 bg-blue-50" : "border-transparent bg-white"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(role)}
                          onChange={(event) =>
                            setProjectGrants((current) => {
                              const next = { ...current };
                              if (event.target.checked) next[project.id] = "viewer";
                              else delete next[project.id];
                              return next;
                            })
                          }
                          className="size-3.5 rounded border-slate-300 accent-blue-900"
                        />
                        <span className="truncate text-xs font-medium text-slate-700">{project.name}</span>
                        <RoleSelect
                          value={role ?? "viewer"}
                          disabled={!role}
                          onChange={(nextRole) => setProjectGrants((current) => ({ ...current, [project.id]: nextRole }))}
                          compact
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-slate-200 pt-4">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void remove()}
                  className="flex items-center gap-1.5 text-xs font-semibold text-rose-700 transition-colors duration-180 hover:text-rose-900"
                >
                  <Trash2 className="size-3.5" />
                  Slett gruppe
                </button>
                <Button type="submit" size="sm" className={PRIMARY_BUTTON_CLASS} disabled={saving}>
                  {saving ? <LoaderCircle className="animate-spin" /> : <Check />}
                  Lagre tilgang
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ActivitySection({ payload }: { payload: ActivityPayload }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"pages" | "all">("pages");
  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("nb-NO");
    return payload.events.filter(
      (event) =>
        (mode === "all" || isReadablePageEvent(event)) &&
        (!term ||
          [event.actor?.display_name, event.actor?.email_masked, event.project?.name, activityPageLabel(event), humanAction(event)]
            .filter(Boolean)
            .some((value) => value?.toLocaleLowerCase("nb-NO").includes(term))),
    );
  }, [mode, payload.events, query]);
  const pageViews = payload.events.filter((event) => event.action === "page.view");
  const uniqueProjects = new Set(pageViews.map((event) => event.project_id).filter(Boolean));

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label="Sidevisninger" value={pageViews.length} detail="Navngitte prosjektfaner" icon={Eye} tone="cyan" />
        <Metric label="Leste prosjekter" value={uniqueProjects.size} detail="I de nyeste 300 hendelsene" icon={FolderKanban} />
        <Metric label="Aktive brukere" value={payload.summary.uniqueUsers} detail="Administratoroppslag inkludert" icon={Users} />
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <SectionHeader
          eyebrow="Revisjonsspor"
          title="Hvem leser hva?"
          description="Standardvisningen prioriterer forståelige sider. Tekniske API-hendelser kan slås på ved behov."
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-y border-slate-200 bg-slate-50/70 px-5 py-3">
          <div className="flex rounded-lg border border-slate-200 bg-white p-1">
            <ModeButton active={mode === "pages"} onClick={() => setMode("pages")}>Sider og dokumenter</ModeButton>
            <ModeButton active={mode === "all"} onClick={() => setMode("all")}>Alle hendelser</ModeButton>
          </div>
          <label className="relative block w-full max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Søk bruker, prosjekt eller side"
              className="bg-white pl-9"
            />
          </label>
        </div>
        <div className="divide-y divide-slate-100">
          {visible.map((event) => (
            <div
              key={event.id}
              className="grid gap-3 px-5 py-4 transition-colors duration-180 hover:bg-slate-50/70 md:grid-cols-[11rem_minmax(12rem,1fr)_minmax(12rem,1fr)_auto] md:items-center"
            >
              <div className="flex items-center gap-2.5">
                <Avatar name={event.actor?.display_name ?? "System"} guest={event.actor?.identity_type === "guest"} small />
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold">{event.actor?.display_name ?? "System"}</p>
                  <p className="text-[0.65rem] text-slate-500">{event.actor?.identity_type === "guest" ? "Gjest" : "Intern"}</p>
                </div>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-800">{humanAction(event)}</p>
                <p className="truncate text-[0.65rem] text-slate-400">{event.action}</p>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-700">{event.project?.name ?? "Global handling"}</p>
                <p className="truncate text-[0.65rem] text-slate-400">{activityPageLabel(event)}</p>
              </div>
              <div className="flex items-center justify-between gap-2 md:justify-end">
                <span className="whitespace-nowrap text-xs text-slate-500">{formatDateTime(event.occurred_at)}</span>
                {event.project_id ? (
                  <a
                    href={`/projects/${event.project_id}`}
                    className="rounded-md p-1 text-blue-900 transition-colors duration-180 hover:bg-blue-50"
                    title="Åpne prosjekt"
                  >
                    <ArrowUpRight className="size-4" />
                  </a>
                ) : null}
              </div>
            </div>
          ))}
          {!visible.length ? <EmptyState icon={Activity} text="Ingen hendelser samsvarer med filteret." /> : null}
        </div>
      </section>
    </div>
  );
}

function GuestCodePanel({ value }: { value: GuestCodeReveal }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-4 border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-amber-800" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-950">Ny personlig gjestekode</p>
          <p className="mt-1 text-xs leading-5 text-amber-800">
            Koden vises bare nå. {value.emailDelivered
              ? `Den er også sendt til ${value.emailMasked}.`
              : `Kopier den og send den sikkert til ${value.emailMasked}.`}
          </p>
          {!value.emailDelivered && value.emailReason ? (
            <p className="mt-1 text-[0.68rem] text-amber-700">
              E-post ble ikke sendt: {value.emailReason}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-amber-200 bg-white px-3 py-2.5 font-mono text-sm font-semibold tracking-wide text-slate-950">
              {value.code}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
              onClick={() => {
                void navigator.clipboard.writeText(value.code);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Kopiert" : "Kopier kode"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: {
  eyebrow: string; title: string; description: string; action: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className={`${EYEBROW_CLASS} text-blue-900`}>{eyebrow}</p>
        <h2 className="mt-1.5 text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
      </div>
      {action}
    </div>
  );
}

function SectionHeader({ eyebrow, title, description, action }: {
  eyebrow: string; title: string; description: string; action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
      <div>
        <p className={`${EYEBROW_CLASS} text-blue-900`}>{eyebrow}</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
      </div>
      {action}
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function NativeSelect({ id, value, onChange, options, placeholder, disabled }: {
  id?: string; value: string; onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>; placeholder?: string; disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={SELECT_CLASS}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

function RoleSelect({ id, value, onChange, disabled, compact, placeholder }: {
  id?: string; value: ShareableRole | ""; onChange: (value: ShareableRole) => void;
  disabled?: boolean; compact?: boolean; placeholder?: string;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as ShareableRole)}
        className={`${SELECT_CLASS} ${compact ? "h-8 py-0 text-xs" : ""}`}
      >
        {placeholder ? <option value="" disabled>{placeholder}</option> : null}
        <option value="restricted_viewer">Kun lese</option>
        <option value="viewer">Lese og laste ned</option>
        <option value="editor">Kan redigere</option>
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

function roleDescription(role: ShareableRole) {
  switch (role) {
    case "editor":
      return "Kan laste opp dokumenter, endre innhold og kjøre analyser.";
    case "viewer":
      return "Kan lese prosjektet og laste ned dokumenter og artefakter.";
    case "restricted_viewer":
      return "Kan lese innholdet i appen, men kan ikke laste ned dokumenter.";
  }
}

function Avatar({ name, admin = false, guest = false, small = false }: {
  name: string; admin?: boolean; guest?: boolean; small?: boolean;
}) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-xl font-bold ${small ? "size-8 text-[0.65rem]" : "size-10 text-xs"} ${
        admin ? "bg-slate-950 text-cyan-300" : guest ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-700"
      }`}
    >
      {name.trim().charAt(0).toLocaleUpperCase("nb-NO") || "?"}
    </span>
  );
}

function EmptyState({ icon: Icon, text }: { icon: typeof Activity; text: string }) {
  return (
    <div className="grid place-items-center px-5 py-12 text-center">
      <span className="grid size-10 place-items-center rounded-xl bg-slate-100 text-slate-400">
        <Icon className="size-5" />
      </span>
      <p className="mt-3 max-w-sm text-sm text-slate-500">{text}</p>
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-all duration-180 ${
        active ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:text-slate-900"
      }`}
    >
      {children}
    </button>
  );
}

function isReadablePageEvent(event: ActivityEvent) {
  if (event.action === "page.view") return true;
  const path = event.metadata?.path ?? "";
  return (
    event.metadata?.method === "GET" &&
    !path.startsWith("/api/") &&
    (path.startsWith("/projects/") || path === "/" || path.startsWith("/service-descriptions"))
  );
}

function activityPageLabel(event: ActivityEvent) {
  if (event.metadata?.pageLabel) return event.metadata.pageLabel;
  if (event.metadata?.page && event.metadata.page in PROJECT_PAGE_LABELS) {
    return PROJECT_PAGE_LABELS[event.metadata.page as keyof typeof PROJECT_PAGE_LABELS];
  }
  const path = event.metadata?.path ?? "";
  if (path.includes("/documents/")) return "Dokument";
  if (/^\/projects\/[^/]+\/chat$/u.test(path)) return "Prosjektchat";
  if (/^\/projects\/[^/]+$/u.test(path)) return "Prosjektoversikt";
  if (path === "/") return "Prosjektliste";
  if (path.startsWith("/service-descriptions")) return "Tjenestebeskrivelser";
  if (path.startsWith("/admin")) return "Tilgang og innsikt";
  if (path.startsWith("/api/")) return "Teknisk API-kall";
  return path || "Global handling";
}

function humanAction(event: ActivityEvent) {
  if (event.action === "page.view") return `Leste ${activityPageLabel(event)}`;
  if (event.action === "admin.user.invite") return "Inviterte en bruker";
  if (event.action === "admin.guest_login.rotate") return "Opprettet ny gjestekode";
  if (event.action === "admin.group.create") return "Opprettet en gruppe";
  if (event.action === "admin.group.delete") return "Slettet en gruppe";
  if (event.action.includes("access_update")) return "Endret tilgang";
  if (event.action.includes("access_revoke")) return "Fjernet tilgang";
  const method = event.metadata?.method;
  if (event.metadata?.path?.includes("/documents/") && method === "GET") return "Åpnet eller lastet ned dokument";
  if (event.metadata?.path?.endsWith("/documents") && method === "POST") return "Lastet opp dokument";
  if (method === "GET") return `Leste ${activityPageLabel(event)}`;
  if (method === "POST") return "Opprettet eller startet behandling";
  if (method === "PATCH" || method === "PUT") return "Endret innhold";
  if (method === "DELETE") return "Slettet innhold";
  return event.action.replaceAll(".", " ");
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("nb-NO", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatRelativeTime(value: string) {
  const minutes = Math.round((new Date(value).getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 1) return "nå";
  if (Math.abs(minutes) < 60) return new Intl.RelativeTimeFormat("nb-NO", { numeric: "auto" }).format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return new Intl.RelativeTimeFormat("nb-NO", { numeric: "auto" }).format(hours, "hour");
  return formatDateTime(value);
}
