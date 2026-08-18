import { ProfileView } from "@/components/profile/profile-view";
import { getPrincipalProfile } from "@/lib/server/access-control-repository";
import { requireRequestPrincipal } from "@/lib/server/authorization";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Min profil – bidsite",
};

export default async function ProfilePage() {
  const principal = await requireRequestPrincipal();
  const profile = await getPrincipalProfile({
    principalId: principal.id,
    sessionId: principal.sessionId,
  });
  const isAdmin = principal.isAdmin || profile?.isAdmin === true;

  return (
    <ProfileView
      profile={profile}
      fallbackIdentityType={principal.identityType}
      isAdmin={isAdmin}
    />
  );
}
