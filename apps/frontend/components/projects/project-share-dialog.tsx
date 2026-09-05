"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  Mail,
  Plus,
  RotateCcw,
  Search,
  Share2,
  ShieldCheck,
  Trash2,
  UserRoundPlus,
  Users,
} from "lucide-react";

import { PROJECT_ROLE_LABELS, type ProjectRole } from "@/lib/access-control";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ShareableRole = Exclude<ProjectRole, "owner">;
type AddMode = "person" | "invite" | "group";
type InheritedGroup = { id: string; name: string; role: ShareableRole };

type AccessMember = {
  principal_id: string;
  role: ProjectRole;
  accepted_at: string | null;
  expires_at: string | null;
  inheritedGroups: InheritedGroup[];
  principal: {
    id: string;
    identity_type: "internal" | "guest";
    display_name: string;
    guest_description: string | null;
    email_masked: string | null;
    disabled_at: string | null;
  } | null;
};

type AccessGroup = {
  group_id: string;
  role: ProjectRole;
  memberCount: number;
  group: { id: string; name: string } | null;
};

type AvailableGroup = {
  id: string;
  name: string;
  memberCount: number;
};

type AvailablePrincipal = {
  id: string;
  identity_type: "internal" | "guest";
  display_name: string;
  guest_description: string | null;
  email_masked: string | null;
  inheritedGroups: InheritedGroup[];
};

type AccessPayload = {
  members: AccessMember[];
  groups: AccessGroup[];
  availableGroups: AvailableGroup[];
  availablePrincipals: AvailablePrincipal[];
};

const SHARE_ROLES: ShareableRole[] = [
  "editor",
  "viewer",
  "restricted_viewer",
];

const ROLE_DETAILS: Record<ShareableRole, { label: string; detail: string }> = {
  editor: {
    label: "Kan redigere",
    detail: "Kan laste opp, endre innhold og kjøre analyser.",
  },
  viewer: {
    label: "Kan lese og laste ned",
    detail: "Kan lese prosjektet og laste ned dokumenter.",
  },
  restricted_viewer: {
    label: "Kun lesing",
    detail: "Kan lese i appen, men ikke laste ned dokumenter.",
  },
};

async function accessRequest<T>(projectId: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/projects/${projectId}/access`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Kunne ikke oppdatere tilgangen.",
    );
  }
  return payload as T;
}

export function ProjectShareDialog({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<AccessPayload | null>(null);
  const [addMode, setAddMode] = useState<AddMode>("person");
  const [selectedPrincipalId, setSelectedPrincipalId] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [personRole, setPersonRole] = useState<ShareableRole>("viewer");
  const [guestName, setGuestName] = useState("");
  const [guestDescription, setGuestDescription] = useState("");
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<ShareableRole>("viewer");
  const [groupId, setGroupId] = useState("");
  const [groupRole, setGroupRole] = useState<ShareableRole>("viewer");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [guestCode, setGuestCode] = useState("");
  const [copied, setCopied] = useState(false);

  const loadAccess = useCallback(async () => {
    setBusy("load");
    setError("");
    try {
      setAccess(await accessRequest<AccessPayload>(projectId));
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Kunne ikke hente tilgang.",
      );
    } finally {
      setBusy("");
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void loadAccess();
  }, [loadAccess, open]);

  async function runAccessMutation<T>({
    key,
    init,
    fallbackError,
    refresh = true,
    onSuccess,
  }: {
    key: string;
    init: RequestInit;
    fallbackError: string;
    refresh?: boolean;
    onSuccess?: (payload: T) => void;
  }) {
    setBusy(key);
    setError("");
    try {
      const payload = await accessRequest<T>(projectId, init);
      onSuccess?.(payload);
      if (refresh) setAccess(await accessRequest<AccessPayload>(projectId));
      return true;
    } catch (mutationError) {
      setError(
        mutationError instanceof Error ? mutationError.message : fallbackError,
      );
      return false;
    } finally {
      setBusy("");
    }
  }

  async function grantPerson() {
    if (!selectedPrincipalId || busy) return;
    const granted = await runAccessMutation<Record<string, never>>({
      key: "person",
      init: {
        method: "POST",
        body: JSON.stringify({
          action: "grant_member",
          principalId: selectedPrincipalId,
          role: personRole,
        }),
      },
      fallbackError: "Kunne ikke gi personen tilgang.",
    });
    if (granted) {
      setSelectedPrincipalId("");
      setPersonQuery("");
    }
  }

  async function invite() {
    if (
      guestName.trim().length < 2 ||
      guestDescription.trim().length < 3 ||
      !email.trim() ||
      busy
    ) return;
    setGuestCode("");
    const invited = await runAccessMutation<{ guestCode?: string }>({
      key: "invite",
      init: {
        method: "POST",
        body: JSON.stringify({
          action: "invite",
          email,
          displayName: guestName,
          guestDescription,
          role: inviteRole,
        }),
      },
      fallbackError: "Kunne ikke invitere personen.",
      onSuccess: (payload) => setGuestCode(payload.guestCode ?? ""),
    });
    if (invited) {
      setGuestName("");
      setGuestDescription("");
      setEmail("");
    }
  }

  async function grantGroup() {
    if (!groupId || busy) return;
    const granted = await runAccessMutation<Record<string, never>>({
      key: "group",
      init: {
        method: "POST",
        body: JSON.stringify({
          action: "grant_group",
          groupId,
          role: groupRole,
        }),
      },
      fallbackError: "Kunne ikke gi gruppen tilgang.",
    });
    if (granted) setGroupId("");
  }

  async function updateAccess(
    target: { principalId?: string; groupId?: string },
    nextRole: ShareableRole,
  ) {
    await runAccessMutation<Record<string, never>>({
      key: target.principalId ?? target.groupId ?? "update",
      init: {
        method: "PATCH",
        body: JSON.stringify({ ...target, role: nextRole }),
      },
      fallbackError: "Kunne ikke endre tilgangen.",
    });
  }

  async function revoke(
    target: { principalId?: string; groupId?: string },
    label: string,
    inheritedGroups: InheritedGroup[] = [],
  ) {
    const inheritanceNote = inheritedGroups.length
      ? ` Personen vil fortsatt ha tilgang gjennom ${inheritedGroups.map((group) => `«${group.name}»`).join(", ")}.`
      : "";
    if (!window.confirm(`Fjerne direkte tilgang for ${label}?${inheritanceNote}`)) return;
    await runAccessMutation<Record<string, never>>({
      key: target.principalId ?? target.groupId ?? "revoke",
      init: {
        method: "DELETE",
        body: JSON.stringify(target),
      },
      fallbackError: "Kunne ikke fjerne tilgangen.",
    });
  }

  async function rotateGuest(principalId: string) {
    setGuestCode("");
    await runAccessMutation<{ code?: string }>({
      key: principalId,
      init: {
        method: "POST",
        body: JSON.stringify({ action: "rotate_guest", principalId }),
      },
      fallbackError: "Kunne ikke bytte gjestekode.",
      refresh: false,
      onSuccess: (payload) => setGuestCode(payload.code ?? ""),
    });
  }

  const ungrantedGroups =
    access?.availableGroups.filter(
      (group) => !access.groups.some((grant) => grant.group_id === group.id),
    ) ?? [];
  const visiblePrincipals = useMemo(() => {
    const term = personQuery.trim().toLocaleLowerCase("nb-NO");
    return (access?.availablePrincipals ?? []).filter((principal) =>
      !term ||
      [principal.display_name, principal.email_masked]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase("nb-NO").includes(term)),
    );
  }, [access?.availablePrincipals, personQuery]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 bg-white">
          <Share2 className="size-4" />
          Tilgang
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92dvh] max-w-4xl overflow-y-auto p-0">
        <DialogHeader className="border-b border-slate-200 px-6 py-5 pr-12">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl bg-blue-950 text-cyan-300">
              <ShieldCheck className="size-5" />
            </span>
            <div>
              <DialogTitle>Tilgang til «{projectName}»</DialogTitle>
              <DialogDescription className="mt-1">
                Legg til personer og grupper, endre tilgangsnivå eller fjern tilgang.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 px-6 pb-6">
          {access ? (
            <div className="grid grid-cols-3 divide-x divide-slate-200 border border-slate-200 bg-slate-50">
              <AccessMetric label="Personer" value={access.members.length} />
              <AccessMetric label="Grupper" value={access.groups.length} />
              <AccessMetric
                label="Mulige å legge til"
                value={access.availablePrincipals.length + ungrantedGroups.length}
              />
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {error}
            </p>
          ) : null}

          {guestCode ? (
            <GuestCodeReveal
              code={guestCode}
              copied={copied}
              onCopy={() => {
                void navigator.clipboard.writeText(guestCode);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              }}
            />
          ) : null}

          <section className="border border-slate-300 bg-white">
            <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
              <p className="text-sm font-semibold text-slate-950">Legg til tilgang</p>
              <p className="mt-1 text-xs text-slate-500">
                Velg en eksisterende person, inviter en ny eller gi tilgang til en hel gruppe.
              </p>
              <div className="mt-4 inline-flex rounded-lg bg-slate-200/70 p-1" role="tablist" aria-label="Type tilgang">
                <ModeButton active={addMode === "person"} icon={UserRoundPlus} label="Person" onClick={() => setAddMode("person")} />
                <ModeButton active={addMode === "invite"} icon={Mail} label="Ny person" onClick={() => setAddMode("invite")} />
                <ModeButton active={addMode === "group"} icon={Users} label="Gruppe" onClick={() => setAddMode("group")} />
              </div>
            </div>

            {addMode === "person" ? (
              <form onSubmit={(event) => { event.preventDefault(); void grantPerson(); }} className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,.9fr)]">
                <div>
                  <Label htmlFor="access-person-search">Finn person</Label>
                  <div className="relative mt-2">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      id="access-person-search"
                      value={personQuery}
                      onChange={(event) => setPersonQuery(event.target.value)}
                      placeholder="Søk på navn eller e-post"
                      className="pl-9"
                    />
                  </div>
                  <div className="mt-2 max-h-52 overflow-y-auto border border-slate-200">
                    {visiblePrincipals.map((principal) => (
                      <button
                        key={principal.id}
                        type="button"
                        onClick={() => setSelectedPrincipalId(principal.id)}
                        className={`flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left last:border-0 ${
                          selectedPrincipalId === principal.id
                            ? "bg-blue-50 text-blue-950"
                            : "bg-white hover:bg-slate-50"
                        }`}
                      >
                        <PersonAvatar name={principal.display_name} guest={principal.identity_type === "guest"} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{principal.display_name}</span>
                          <span className="block truncate text-xs text-slate-500">
                            {principal.email_masked ?? (principal.identity_type === "guest" ? "Gjest" : "Microsoft-konto")}
                          </span>
                          {principal.inheritedGroups.length ? (
                            <span className="mt-0.5 block text-[0.68rem] text-cyan-800">
                              Har allerede tilgang via {principal.inheritedGroups.map((group) => group.name).join(", ")}
                            </span>
                          ) : null}
                        </span>
                        {selectedPrincipalId === principal.id ? <Check className="size-4 text-blue-900" /> : null}
                      </button>
                    ))}
                    {!visiblePrincipals.length ? (
                      <p className="px-4 py-6 text-center text-xs text-slate-500">
                        {access?.availablePrincipals.length ? "Ingen personer samsvarer med søket." : "Alle registrerte personer har direkte tilgang."}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div>
                  <AccessLevelPicker value={personRole} onChange={setPersonRole} />
                  <Button type="submit" className="mt-4 w-full bg-primary text-primary-foreground hover:bg-primary-hover" disabled={!selectedPrincipalId || Boolean(busy)}>
                    {busy === "person" ? <LoaderCircle className="animate-spin" /> : <Plus />}
                    Gi personen tilgang
                  </Button>
                </div>
              </form>
            ) : null}

            {addMode === "invite" ? (
              <form onSubmit={(event) => { event.preventDefault(); void invite(); }} className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,.9fr)]">
                <div className="grid gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Navn" htmlFor="share-name">
                      <Input id="share-name" value={guestName} placeholder="Ola Nordmann" minLength={2} maxLength={120} required onChange={(event) => setGuestName(event.target.value)} />
                    </Field>
                    <Field label="E-post" htmlFor="share-email">
                      <Input id="share-email" type="email" value={email} placeholder="ola@firma.no" maxLength={320} required onChange={(event) => setEmail(event.target.value)} />
                    </Field>
                  </div>
                  <Field label="Hvorfor trenger personen tilgang?" htmlFor="share-description">
                    <Textarea id="share-description" value={guestDescription} placeholder="For eksempel: Ekstern løsningsarkitekt fra samarbeidspartner" minLength={3} maxLength={240} rows={3} required onChange={(event) => setGuestDescription(event.target.value)} />
                  </Field>
                  <p className="text-xs leading-5 text-slate-500">
                    En eksisterende intern bruker fortsetter med Microsoft. En ny ekstern person får en personlig kode på e-post.
                  </p>
                </div>
                <div>
                  <AccessLevelPicker value={inviteRole} onChange={setInviteRole} />
                  <Button type="submit" className="mt-4 w-full bg-primary text-primary-foreground hover:bg-primary-hover" disabled={guestName.trim().length < 2 || guestDescription.trim().length < 3 || !email.trim() || Boolean(busy)}>
                    {busy === "invite" ? <LoaderCircle className="animate-spin" /> : <Mail />}
                    Inviter og gi tilgang
                  </Button>
                </div>
              </form>
            ) : null}

            {addMode === "group" ? (
              <form onSubmit={(event) => { event.preventDefault(); void grantGroup(); }} className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,.9fr)]">
                <Field label="Velg gruppe" htmlFor="share-group">
                  <select id="share-group" value={groupId} onChange={(event) => setGroupId(event.target.value)} className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm">
                    <option value="">Velg gruppe</option>
                    {ungrantedGroups.map((group) => (
                      <option key={group.id} value={group.id}>{group.name} ({group.memberCount} medlemmer)</option>
                    ))}
                  </select>
                  {!ungrantedGroups.length ? (
                    <p className="mt-2 text-xs text-slate-500">
                      {access?.availableGroups.length
                        ? "Alle grupper har allerede tilgang til prosjektet."
                        : "Ingen grupper er opprettet ennå. Opprett en gruppe under Styring og innsikt."}
                    </p>
                  ) : null}
                </Field>
                <div>
                  <AccessLevelPicker value={groupRole} onChange={setGroupRole} />
                  <Button type="submit" className="mt-4 w-full bg-primary text-primary-foreground hover:bg-primary-hover" disabled={!groupId || Boolean(busy)}>
                    {busy === "group" ? <LoaderCircle className="animate-spin" /> : <Users />}
                    Gi gruppen tilgang
                  </Button>
                </div>
              </form>
            ) : null}
          </section>

          <section>
            <div className="flex items-end justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-950">Nåværende tilgang</h3>
                <p className="mt-1 text-xs text-slate-500">Endringer i tilgangsnivå lagres med en gang.</p>
              </div>
              {busy === "load" ? <LoaderCircle className="size-5 animate-spin text-blue-900" /> : null}
            </div>

            <div className="mt-3 overflow-hidden border border-slate-200">
              <AccessSectionLabel>Personer</AccessSectionLabel>
              <div className="divide-y divide-slate-100">
                {access?.members.map((member) => {
                  const isOwner = member.role === "owner";
                  const isGuest = member.principal?.identity_type === "guest";
                  const name = member.principal?.display_name ?? "Ukjent person";
                  return (
                    <div key={member.principal_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <PersonAvatar name={name} guest={isGuest} />
                      <div className="min-w-44 flex-1">
                        <p className="text-sm font-semibold text-slate-900">
                          {name}
                          {isGuest ? <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[0.62rem] uppercase tracking-wide text-amber-800">Gjest</span> : null}
                        </p>
                        <p className="text-xs text-slate-500">{member.principal?.email_masked ?? (member.accepted_at ? "Aktiv" : "Invitert")}</p>
                        {member.inheritedGroups.length ? (
                          <p className="mt-1 text-[0.68rem] text-cyan-800">
                            Har også tilgang via {member.inheritedGroups.map((group) => group.name).join(", ")}
                          </p>
                        ) : null}
                      </div>
                      {isOwner ? (
                        <span className="text-sm font-medium text-slate-600">{PROJECT_ROLE_LABELS.owner}</span>
                      ) : (
                        <>
                          <RoleSelect value={member.role as ShareableRole} disabled={busy === member.principal_id} onChange={(nextRole) => void updateAccess({ principalId: member.principal_id }, nextRole)} />
                          {busy === member.principal_id ? <LoaderCircle className="size-4 animate-spin text-blue-900" /> : null}
                          {isGuest ? (
                            <button type="button" title="Lag ny kode og logg ut aktive økter" onClick={() => void rotateGuest(member.principal_id)} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
                              <RotateCcw className="size-4" />
                            </button>
                          ) : null}
                          <button type="button" title="Fjern direkte tilgang" onClick={() => void revoke({ principalId: member.principal_id }, name, member.inheritedGroups)} className="rounded-md p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-700">
                            <Trash2 className="size-4" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
                {!access?.members.length && busy !== "load" ? <p className="px-4 py-6 text-center text-xs text-slate-500">Ingen personer har direkte tilgang.</p> : null}
              </div>

              <AccessSectionLabel>Grupper</AccessSectionLabel>
              <div className="divide-y divide-slate-100">
                {access?.groups.map((grant) => {
                  const name = grant.group?.name ?? "Ukjent gruppe";
                  return (
                    <div key={grant.group_id} className="flex items-center gap-3 px-4 py-3">
                      <span className="grid size-9 place-items-center rounded-lg bg-cyan-50 text-cyan-800"><Users className="size-4" /></span>
                      <div className="min-w-32 flex-1">
                        <p className="text-sm font-semibold text-slate-900">{name}</p>
                        <p className="text-xs text-slate-500">{grant.memberCount} medlemmer får tilgang</p>
                      </div>
                      <RoleSelect value={grant.role as ShareableRole} disabled={busy === grant.group_id} onChange={(nextRole) => void updateAccess({ groupId: grant.group_id }, nextRole)} />
                      {busy === grant.group_id ? <LoaderCircle className="size-4 animate-spin text-blue-900" /> : null}
                      <button type="button" title="Fjern gruppetilgang" onClick={() => void revoke({ groupId: grant.group_id }, name)} className="rounded-md p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-700">
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  );
                })}
                {!access?.groups.length && busy !== "load" ? <p className="px-4 py-6 text-center text-xs text-slate-500">Ingen grupper har tilgang.</p> : null}
              </div>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModeButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof Users; label: string; onClick: () => void }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold transition-colors ${active ? "bg-white text-blue-950 shadow-sm" : "text-slate-600 hover:text-slate-950"}`}>
      <Icon className="size-3.5" /> {label}
    </button>
  );
}

function AccessLevelPicker({ value, onChange }: { value: ShareableRole; onChange: (role: ShareableRole) => void }) {
  return (
    <fieldset>
      <legend className="text-sm font-semibold text-slate-900">Hva skal de kunne gjøre?</legend>
      <div className="mt-2 grid gap-2">
        {SHARE_ROLES.map((role) => {
          const selected = value === role;
          return (
            <button key={role} type="button" onClick={() => onChange(role)} aria-pressed={selected} className={`flex items-start gap-3 border px-3 py-3 text-left transition-colors ${selected ? "border-blue-900 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-400"}`}>
              <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-slate-300"}`}>{selected ? <Check className="size-2.5" /> : null}</span>
              <span>
                <span className="block text-xs font-semibold text-slate-900">{ROLE_DETAILS[role].label}</span>
                <span className="mt-0.5 block text-[0.68rem] leading-4 text-slate-500">{ROLE_DETAILS[role].detail}</span>
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function RoleSelect({ value, onChange, disabled }: { value: ShareableRole; onChange: (role: ShareableRole) => void; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} aria-label="Tilgangsnivå" onChange={(event) => onChange(event.target.value as ShareableRole)} className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 disabled:opacity-60">
      {SHARE_ROLES.map((option) => <option key={option} value={option}>{ROLE_DETAILS[option].label}</option>)}
    </select>
  );
}

function AccessMetric({ label, value }: { label: string; value: number }) {
  return <div className="px-4 py-3 text-center"><p className="text-lg font-bold tabular-nums text-slate-950">{value}</p><p className="text-[0.68rem] text-slate-500">{label}</p></div>;
}

function PersonAvatar({ name, guest }: { name: string; guest?: boolean }) {
  return <span className={`grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold ${guest ? "bg-amber-100 text-amber-800" : "bg-blue-50 text-blue-900"}`}>{name.charAt(0).toUpperCase() || "?"}</span>;
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return <div><Label htmlFor={htmlFor}>{label}</Label><div className="mt-2">{children}</div></div>;
}

function AccessSectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="border-y border-slate-200 bg-slate-50 px-4 py-2 first:border-t-0"><p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-slate-500">{children}</p></div>;
}

function GuestCodeReveal({ code, copied, onCopy }: { code: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 text-amber-700" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-950">Ny personlig kode</p>
          <p className="mt-1 text-xs leading-5 text-amber-800">Koden vises bare nå. Den sendes også på e-post når e-posttjenesten er konfigurert.</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto bg-white px-3 py-2 text-xs font-semibold text-slate-900 ring-1 ring-amber-200">{code}</code>
            <Button size="sm" variant="outline" type="button" onClick={onCopy}>{copied ? <Check /> : <Copy />}{copied ? "Kopiert" : "Kopier"}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
