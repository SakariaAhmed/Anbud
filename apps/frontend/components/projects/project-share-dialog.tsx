"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  Share2,
  Trash2,
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

type AccessMember = {
  principal_id: string;
  role: ProjectRole;
  accepted_at: string | null;
  expires_at: string | null;
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
  group: { id: string; name: string } | null;
};

type AvailableGroup = {
  id: string;
  name: string;
  memberCount: number;
};

type AccessPayload = {
  members: AccessMember[];
  groups: AccessGroup[];
  availableGroups: AvailableGroup[];
};

const SHARE_ROLES: Array<Exclude<ProjectRole, "owner">> = [
  "editor",
  "viewer",
  "restricted_viewer",
];

async function accessRequest(projectId: string, init?: RequestInit) {
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
        : "Kunne ikke oppdatere delingen.",
    );
  }
  return payload;
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
  const [guestName, setGuestName] = useState("");
  const [guestDescription, setGuestDescription] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] =
    useState<Exclude<ProjectRole, "owner">>("restricted_viewer");
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [guestCode, setGuestCode] = useState("");
  const [copied, setCopied] = useState(false);

  const loadAccess = useCallback(async () => {
    setBusy("load");
    setError("");
    try {
      const payload = await accessRequest(projectId);
      setAccess(payload as unknown as AccessPayload);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Kunne ikke hente deling.",
      );
    } finally {
      setBusy("");
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void loadAccess();
  }, [loadAccess, open]);

  async function invite() {
    if (
      guestName.trim().length < 2 ||
      guestDescription.trim().length < 3 ||
      !email.trim() ||
      busy
    ) return;
    setBusy("invite");
    setError("");
    setGuestCode("");
    try {
      const payload = await accessRequest(projectId, {
        method: "POST",
        body: JSON.stringify({
          action: "invite",
          email,
          displayName: guestName,
          guestDescription,
          role,
        }),
      });
      if (typeof payload.guestCode === "string") {
        setGuestCode(payload.guestCode);
      }
      setGuestName("");
      setGuestDescription("");
      setEmail("");
      await loadAccess();
    } catch (inviteError) {
      setError(
        inviteError instanceof Error
          ? inviteError.message
          : "Kunne ikke invitere gjesten.",
      );
    } finally {
      setBusy("");
    }
  }

  async function grantGroup() {
    if (!groupId || busy) return;
    setBusy("group");
    setError("");
    try {
      await accessRequest(projectId, {
        method: "POST",
        body: JSON.stringify({
          action: "grant_group",
          groupId,
          role,
        }),
      });
      setGroupId("");
      await loadAccess();
    } catch (groupError) {
      setError(
        groupError instanceof Error
          ? groupError.message
          : "Kunne ikke dele med gruppen.",
      );
    } finally {
      setBusy("");
    }
  }

  async function updateAccess(
    target: { principalId?: string; groupId?: string },
    nextRole: Exclude<ProjectRole, "owner">,
  ) {
    setBusy(target.principalId ?? target.groupId ?? "update");
    setError("");
    try {
      await accessRequest(projectId, {
        method: "PATCH",
        body: JSON.stringify({ ...target, role: nextRole }),
      });
      await loadAccess();
    } catch (updateError) {
      setError(
        updateError instanceof Error ? updateError.message : "Kunne ikke endre rolle.",
      );
    } finally {
      setBusy("");
    }
  }

  async function revoke(target: {
    principalId?: string;
    groupId?: string;
  }) {
    setBusy(target.principalId ?? target.groupId ?? "revoke");
    setError("");
    try {
      await accessRequest(projectId, {
        method: "DELETE",
        body: JSON.stringify(target),
      });
      await loadAccess();
    } catch (revokeError) {
      setError(
        revokeError instanceof Error
          ? revokeError.message
          : "Kunne ikke fjerne tilgang.",
      );
    } finally {
      setBusy("");
    }
  }

  async function rotateGuest(principalId: string) {
    setBusy(principalId);
    setError("");
    setGuestCode("");
    try {
      const payload = await accessRequest(projectId, {
        method: "POST",
        body: JSON.stringify({ action: "rotate_guest", principalId }),
      });
      if (typeof payload.code === "string") setGuestCode(payload.code);
    } catch (rotateError) {
      setError(
        rotateError instanceof Error
          ? rotateError.message
          : "Kunne ikke bytte gjestekode.",
      );
    } finally {
      setBusy("");
    }
  }

  const ungrantedGroups =
    access?.availableGroups.filter(
      (group) => !access.groups.some((grant) => grant.group_id === group.id),
    ) ?? [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 bg-white">
          <Share2 className="size-4" />
          Del
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[88dvh] max-w-2xl overflow-y-auto p-0">
        <DialogHeader className="border-b border-slate-200 px-6 py-5 pr-12">
          <DialogTitle>Del «{projectName}»</DialogTitle>
          <DialogDescription>
            Gi én person eller en administrert gruppe en avgrenset rolle.
            Samme gjest kan få flere prosjekter senere med samme kode.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 px-6 pb-6">
          {error ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {error}
            </p>
          ) : null}

          {guestCode ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-start gap-3">
                <KeyRound className="mt-0.5 size-5 text-amber-700" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-amber-950">
                    Ny personlig kode
                  </p>
                  <p className="mt-1 text-xs leading-5 text-amber-800">
                    Koden vises bare nå. Den er også sendt på e-post når
                    e-posttjenesten er konfigurert.
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-white px-3 py-2 text-xs font-semibold text-slate-900 ring-1 ring-amber-200">
                      {guestCode}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void navigator.clipboard.writeText(guestCode);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1800);
                      }}
                    >
                      {copied ? <Check /> : <Copy />}
                      {copied ? "Kopiert" : "Kopier"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <section>
            <Label htmlFor="share-name">Inviter gjest</Label>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Navn og en kort beskrivelse er obligatorisk og blir synlig for de som administrerer tilgangen.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void invite();
              }}
              className="mt-3 grid gap-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="share-name" className="sr-only">Navn</Label>
                  <Input
                    id="share-name"
                    value={guestName}
                    placeholder="Navn på gjesten"
                    minLength={2}
                    maxLength={120}
                    required
                    onChange={(event) => setGuestName(event.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="share-email" className="sr-only">E-post</Label>
                  <Input
                    id="share-email"
                    type="email"
                    value={email}
                    placeholder="navn@eksempel.no"
                    maxLength={320}
                    required
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="share-description" className="sr-only">Kort beskrivelse av gjesten</Label>
                <Textarea
                  id="share-description"
                  value={guestDescription}
                  placeholder="Kort beskrivelse, for eksempel rolle og organisasjon"
                  minLength={3}
                  maxLength={240}
                  rows={2}
                  required
                  onChange={(event) => setGuestDescription(event.target.value)}
                />
                <p className="mt-1 text-right text-[0.68rem] text-slate-400">
                  {guestDescription.length}/240 tegn
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-[12rem_auto] sm:justify-end">
                <RoleSelect value={role} onChange={setRole} />
                <Button
                  type="submit"
                  disabled={
                    guestName.trim().length < 2 ||
                    guestDescription.trim().length < 3 ||
                    !email.trim() ||
                    Boolean(busy)
                  }
                >
                  {busy === "invite" ? <LoaderCircle className="animate-spin" /> : <Share2 />}
                  Inviter
                </Button>
              </div>
            </form>
          </section>

          {ungrantedGroups.length ? (
            <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <Label htmlFor="share-group" className="flex items-center gap-2">
                <Users className="size-4" />
                Del med gruppe
              </Label>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void grantGroup();
                }}
                className="mt-2 grid gap-2 sm:grid-cols-[1fr_12rem_auto]"
              >
                <select
                  id="share-group"
                  value={groupId}
                  onChange={(event) => setGroupId(event.target.value)}
                  className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm"
                >
                  <option value="">Velg gruppe</option>
                  {ungrantedGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({group.memberCount})
                    </option>
                  ))}
                </select>
                <RoleSelect value={role} onChange={setRole} />
                <Button type="submit" variant="outline" disabled={!groupId || Boolean(busy)}>
                  Legg til
                </Button>
              </form>
            </section>
          ) : null}

          <section>
            <h3 className="text-sm font-semibold text-slate-950">
              Personer og grupper med tilgang
            </h3>
            {busy === "load" && !access ? (
              <div className="grid place-items-center py-10 text-slate-500">
                <LoaderCircle className="size-5 animate-spin" />
              </div>
            ) : (
              <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {access?.members.map((member) => {
                  const isOwner = member.role === "owner";
                  const isGuest = member.principal?.identity_type === "guest";
                  return (
                    <div key={member.principal_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <span className="grid size-9 place-items-center rounded-full bg-blue-50 text-sm font-bold text-blue-800">
                        {(member.principal?.display_name ?? "?").charAt(0)}
                      </span>
                      <div className="min-w-32 flex-1">
                        <p className="text-sm font-semibold text-slate-900">
                          {member.principal?.display_name ?? "Ukjent bruker"}
                          {isGuest ? (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-amber-800">
                              Gjest
                            </span>
                          ) : null}
                        </p>
                        <p className="text-xs text-slate-500">
                          {member.principal?.email_masked ??
                            (member.accepted_at ? "Aktiv" : "Invitert")}
                        </p>
                        {isGuest ? (
                          <p className="mt-1 text-xs leading-5 text-slate-600">
                            {member.principal?.guest_description ??
                              "Ingen gjestebeskrivelse registrert."}
                          </p>
                        ) : null}
                      </div>
                      {isOwner ? (
                        <span className="text-sm text-slate-600">
                          {PROJECT_ROLE_LABELS.owner}
                        </span>
                      ) : (
                        <>
                          <RoleSelect
                            value={member.role as Exclude<ProjectRole, "owner">}
                            onChange={(nextRole) =>
                              void updateAccess(
                                { principalId: member.principal_id },
                                nextRole,
                              )
                            }
                          />
                          {isGuest ? (
                            <button
                              type="button"
                              title="Bytt kode og logg ut aktive økter"
                              onClick={() => void rotateGuest(member.principal_id)}
                              className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                            >
                              <RotateCcw className="size-4" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            title="Fjern tilgang"
                            onClick={() =>
                              void revoke({ principalId: member.principal_id })
                            }
                            className="rounded-md p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-700"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
                {access?.groups.map((grant) => (
                  <div key={grant.group_id} className="flex items-center gap-3 px-4 py-3">
                    <span className="grid size-9 place-items-center rounded-lg bg-violet-50 text-violet-800">
                      <Users className="size-4" />
                    </span>
                    <p className="min-w-32 flex-1 text-sm font-semibold text-slate-900">
                      {grant.group?.name ?? "Ukjent gruppe"}
                    </p>
                    <RoleSelect
                      value={grant.role as Exclude<ProjectRole, "owner">}
                      onChange={(nextRole) =>
                        void updateAccess({ groupId: grant.group_id }, nextRole)
                      }
                    />
                    <button
                      type="button"
                      title="Fjern gruppetilgang"
                      onClick={() => void revoke({ groupId: grant.group_id })}
                      className="rounded-md p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-700"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RoleSelect({
  value,
  onChange,
}: {
  value: Exclude<ProjectRole, "owner">;
  onChange: (role: Exclude<ProjectRole, "owner">) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) =>
        onChange(event.target.value as Exclude<ProjectRole, "owner">)
      }
      className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700"
    >
      {SHARE_ROLES.map((option) => (
        <option key={option} value={option}>
          {PROJECT_ROLE_LABELS[option]}
        </option>
      ))}
    </select>
  );
}
