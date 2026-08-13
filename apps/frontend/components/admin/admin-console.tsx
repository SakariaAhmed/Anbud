"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Download,
  FolderKanban,
  LoaderCircle,
  Plus,
  Search,
  Shield,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AdminUser = {
  id: string;
  identity_type: "internal" | "guest";
  display_name: string;
  email_masked: string | null;
  disabled_at: string | null;
  last_login_at: string | null;
  isAdmin: boolean;
  projectCount: number;
};

type AdminGroup = {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  projectCount: number;
};

type ActivityEvent = {
  id: number;
  occurred_at: string;
  action: string;
  result: string;
  project_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  actor: {
    id: string;
    display_name: string;
    identity_type: "internal" | "guest";
    email_masked: string | null;
  } | null;
  project: { id: string; name: string } | null;
  metadata: { path?: string; method?: string } | null;
};

type ActivityPayload = {
  events: ActivityEvent[];
  summary: {
    total: number;
    uniqueUsers: number;
    downloads: number;
    writes: number;
  };
};

type Section = "activity" | "users" | "groups";

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error || "Forespørselen feilet.");
  return payload;
}

export function AdminConsole() {
  const [section, setSection] = useState<Section>("activity");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [activity, setActivity] = useState<ActivityPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [usersPayload, groupsPayload, activityPayload] = await Promise.all([
        readJson<{ users: AdminUser[] }>("/api/admin/users"),
        readJson<{ groups: AdminGroup[] }>("/api/admin/groups"),
        readJson<ActivityPayload>("/api/admin/activity?limit=300"),
      ]);
      setUsers(usersPayload.users);
      setGroups(groupsPayload.groups);
      setActivity(activityPayload);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Kunne ikke laste styringsdata.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleEvents = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("nb-NO");
    if (!normalized) return activity?.events ?? [];
    return (activity?.events ?? []).filter((event) =>
      [
        event.actor?.display_name,
        event.actor?.email_masked,
        event.project?.name,
        event.action,
        event.metadata?.path,
      ].some((value) => value?.toLocaleLowerCase("nb-NO").includes(normalized)),
    );
  }, [activity, query]);

  return (
    <div className="min-h-[calc(100dvh-var(--app-header-height))] bg-slate-50">
      <div className="border-b border-slate-200 bg-[#08172d] text-white">
        <div className="mx-auto max-w-[1500px] px-6 py-10 lg:px-10">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.2em] text-cyan-300">
            Global styring
          </p>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-5">
            <div>
              <h1 className="font-serif text-4xl font-semibold tracking-tight">
                Tilgang og innsikt
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
                Administrer roller og grupper, les alle prosjekter og følg hvem
                som åpner, endrer, laster opp og laster ned.
              </p>
            </div>
            <div className="flex gap-2">
              <span className="rounded-full border border-blue-300/25 bg-blue-300/10 px-3 py-1.5 text-xs font-semibold text-blue-100">
                Administrator
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-[1500px] gap-7 px-6 py-8 lg:grid-cols-[15rem_1fr] lg:px-10">
        <nav className="space-y-1">
          <NavButton
            active={section === "activity"}
            icon={<Activity />}
            label="Aktivitet"
            onClick={() => setSection("activity")}
          />
          <NavButton
            active={section === "users"}
            icon={<Shield />}
            label="Brukere og roller"
            onClick={() => setSection("users")}
          />
          <NavButton
            active={section === "groups"}
            icon={<Users />}
            label="Grupper"
            onClick={() => setSection("groups")}
          />
        </nav>

        <main className="min-w-0">
          {error ? (
            <p className="mb-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              {error}
            </p>
          ) : null}
          {loading ? (
            <div className="grid min-h-80 place-items-center rounded-2xl border border-slate-200 bg-white">
              <LoaderCircle className="size-6 animate-spin text-blue-700" />
            </div>
          ) : null}
          {!loading && section === "activity" && activity ? (
            <ActivitySection
              payload={activity}
              events={visibleEvents}
              query={query}
              onQueryChange={setQuery}
            />
          ) : null}
          {!loading && section === "users" ? (
            <UsersSection users={users} onReload={load} />
          ) : null}
          {!loading && section === "groups" ? (
            <GroupsSection groups={groups} users={users} onReload={load} />
          ) : null}
        </main>
      </div>
    </div>
  );
}

function NavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
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

function ActivitySection({
  payload,
  events,
  query,
  onQueryChange,
}: {
  payload: ActivityPayload;
  events: ActivityEvent[];
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const stats = [
    { label: "Hendelser", value: payload.summary.total, icon: Activity },
    { label: "Aktive brukere", value: payload.summary.uniqueUsers, icon: Users },
    { label: "Skrivehandlinger", value: payload.summary.writes, icon: FolderKanban },
    { label: "Nedlastinger", value: payload.summary.downloads, icon: Download },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {stat.label}
              </p>
              <stat.icon className="size-4 text-blue-700" />
            </div>
            <p className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
              {stat.value}
            </p>
          </div>
        ))}
      </div>
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="font-serif text-xl font-semibold">Aktivitetsstrøm</h2>
            <p className="mt-1 text-xs text-slate-500">
              Nyeste 300 hendelser. Administratoroppslag logges også.
            </p>
          </div>
          <label className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Søk bruker, prosjekt eller handling"
              className="w-72 pl-9"
            />
          </label>
        </div>
        <div className="divide-y divide-slate-100">
          {events.map((event) => (
            <div key={event.id} className="grid gap-2 px-5 py-3.5 md:grid-cols-[11rem_1fr_1fr_auto] md:items-center">
              <div>
                <p className="truncate text-sm font-semibold text-slate-900">
                  {event.actor?.display_name ?? "System"}
                </p>
                <p className="text-xs text-slate-500">
                  {event.actor?.identity_type === "guest" ? "Gjest" : "Intern"}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-slate-800">
                  {humanAction(event)}
                </p>
                <p className="truncate font-mono text-[0.65rem] text-slate-400">
                  {event.action}
                </p>
              </div>
              <p className="truncate text-sm text-slate-600">
                {event.project?.name ?? event.metadata?.path ?? "Global handling"}
              </p>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                {event.project_id ? (
                  <a
                    href={`/projects/${event.project_id}`}
                    className="rounded-md p-1 text-blue-700 hover:bg-blue-50"
                    title="Åpne prosjekt"
                  >
                    <ArrowUpRight className="size-4" />
                  </a>
                ) : null}
                {new Intl.DateTimeFormat("nb-NO", {
                  dateStyle: "short",
                  timeStyle: "short",
                }).format(new Date(event.occurred_at))}
              </div>
            </div>
          ))}
          {!events.length ? (
            <p className="px-5 py-12 text-center text-sm text-slate-500">
              Ingen hendelser samsvarer med søket.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function humanAction(event: ActivityEvent) {
  const method = event.metadata?.method;
  if (event.metadata?.path?.includes("/documents/") && method === "GET") {
    return "Åpnet eller lastet ned dokument";
  }
  if (event.metadata?.path?.endsWith("/documents") && method === "POST") {
    return "Lastet opp dokument";
  }
  if (method === "GET") return "Leste innhold";
  if (method === "POST") return "Opprettet eller startet behandling";
  if (method === "PATCH" || method === "PUT") return "Endret innhold";
  if (method === "DELETE") return "Slettet innhold";
  return event.action;
}

function UsersSection({
  users,
  onReload,
}: {
  users: AdminUser[];
  onReload: () => Promise<void>;
}) {
  async function toggleAdmin(user: AdminUser) {
    await readJson("/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ principalId: user.id, isAdmin: !user.isAdmin }),
    });
    await onReload();
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-5 py-4">
        <h2 className="font-serif text-xl font-semibold">Brukere og globale roller</h2>
        <p className="mt-1 text-xs text-slate-500">
          Administratorrollen gir global styring, lesing og innsikt.
        </p>
      </div>
      <div className="divide-y divide-slate-100">
        {users.map((user) => (
          <div key={user.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
            <span className="grid size-10 place-items-center rounded-full bg-slate-100 text-sm font-bold text-slate-700">
              {user.display_name.charAt(0)}
            </span>
            <div className="min-w-48 flex-1">
              <p className="text-sm font-semibold text-slate-900">
                {user.display_name}
                {user.identity_type === "guest" ? (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[0.65rem] uppercase text-amber-800">
                    Gjest
                  </span>
                ) : null}
              </p>
              <p className="text-xs text-slate-500">
                {user.email_masked ?? "E-post ikke tilgjengelig"} · {user.projectCount} prosjekt
              </p>
            </div>
            {user.identity_type === "internal" ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void toggleAdmin(user)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                    user.isAdmin
                      ? "border-blue-200 bg-blue-50 text-blue-800"
                      : "border-slate-200 text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  Administrator
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function GroupsSection({
  groups,
  users,
  onReload,
}: {
  groups: AdminGroup[];
  users: AdminUser[];
  onReload: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await readJson("/api/admin/groups", {
        method: "POST",
        body: JSON.stringify({ name, description }),
      });
      setName("");
      setDescription("");
      await onReload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="font-serif text-xl font-semibold">Ny gruppe</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1.5fr_auto] md:items-end">
          <div>
            <Label htmlFor="group-name">Navn</Label>
            <Input id="group-name" className="mt-2" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div>
            <Label htmlFor="group-description">Beskrivelse</Label>
            <Input id="group-description" className="mt-2" value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
          <Button onClick={() => void create()} disabled={!name.trim() || busy}>
            {busy ? <LoaderCircle className="animate-spin" /> : <Plus />}
            Opprett
          </Button>
        </div>
      </section>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            users={users}
            onReload={onReload}
          />
        ))}
      </section>
    </div>
  );
}

function GroupCard({
  group,
  users,
  onReload,
}: {
  group: AdminGroup;
  users: AdminUser[];
  onReload: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  async function loadMembers() {
    if (loaded) return;
    const detail = await readJson<{ members: Array<{ id: string }> }>(
      `/api/admin/groups/${group.id}`,
    );
    setSelected(detail.members.map((member) => member.id));
    setLoaded(true);
  }

  async function saveMembers() {
    setSaving(true);
    try {
      await readJson(`/api/admin/groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({ principalIds: selected }),
      });
      await onReload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="self-start rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <span className="grid size-10 place-items-center rounded-lg bg-violet-50 text-violet-800">
          <Users className="size-5" />
        </span>
        <span className="text-xs text-slate-500">
          {group.projectCount} prosjekt
        </span>
      </div>
      <h3 className="mt-4 font-semibold text-slate-950">{group.name}</h3>
      <p className="mt-1 min-h-10 text-sm leading-5 text-slate-500">
        {group.description || "Ingen beskrivelse"}
      </p>
      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-600">
          {group.memberCount} medlemmer
        </p>
        <button
          type="button"
          onClick={() => {
            setExpanded((value) => !value);
            void loadMembers();
          }}
          className="text-xs font-semibold text-blue-700 hover:text-blue-900"
        >
          {expanded ? "Lukk" : "Administrer"}
        </button>
      </div>
      {expanded ? (
        <div className="mt-4 border-t border-slate-100 pt-4">
          {!loaded ? (
            <LoaderCircle className="mx-auto size-4 animate-spin text-blue-700" />
          ) : (
            <>
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {users.map((user) => (
                  <label
                    key={user.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(user.id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, user.id]
                            : current.filter((id) => id !== user.id),
                        )
                      }
                      className="size-3.5 rounded border-slate-300"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {user.display_name}
                    </span>
                    {user.identity_type === "guest" ? (
                      <span className="text-amber-700">Gjest</span>
                    ) : null}
                  </label>
                ))}
              </div>
              <Button
                size="sm"
                className="mt-3 w-full"
                onClick={() => void saveMembers()}
                disabled={saving}
              >
                {saving ? <LoaderCircle className="animate-spin" /> : null}
                Lagre medlemmer
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
