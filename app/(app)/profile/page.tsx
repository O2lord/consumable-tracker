import { requireSession } from "@/server/auth/session";
import { PERMISSION_GROUPS, can, canWorkAtAnyLocation } from "@/server/auth/permissions";
import { getProfile } from "@/server/services/profile.service";
import { Tag } from "@/components/ui/Tag";
import { cardClass } from "@/components/ui/styles";

export const metadata = { title: "My profile" };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0] ?? "?"];
  return letters.map((p) => p[0]?.toUpperCase() ?? "").join("");
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[13px] font-semibold text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

export default async function ProfilePage() {
  const session = await requireSession();
  const profile = await getProfile(session.userId);

  // Only the permission groups where this person holds at least one permission are shown.
  const groups = PERMISSION_GROUPS.map((g) => ({
    title: g.title,
    items: g.items.filter((i) => can(session.role, i.permission)),
  })).filter((g) => g.items.length > 0);

  const memberSince = new Intl.DateTimeFormat("en-GB", { dateStyle: "long" }).format(profile.createdAt);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">My profile</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Your account details and what your role lets you do. To change any of this, ask an admin.
        </p>
      </div>

      <section className={`${cardClass} flex flex-col gap-5 md:flex-row md:items-start md:gap-6`}>
        <div
          aria-hidden="true"
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xl font-bold text-brand"
        >
          {initials(profile.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold">{profile.name}</h2>
            <Tag tone="brand">{profile.roleName}</Tag>
            {!profile.active && <Tag tone="bad">Inactive</Tag>}
          </div>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <Detail label="Staff ID">
              <span className="tabular-nums">{profile.staffId}</span>
            </Detail>
            <Detail label="Home location">
              {profile.homeLocationName ? (
                <>
                  {profile.homeLocationName}{" "}
                  <span className="text-muted">({profile.homeLocationCode})</span>
                </>
              ) : (
                <span className="text-muted">None assigned</span>
              )}
            </Detail>
            <Detail label="Works at">
              {canWorkAtAnyLocation(session.role) ? "Any location" : "Home location only"}
            </Detail>
            <Detail label="Member since">{memberSince}</Detail>
          </dl>
        </div>
      </section>

      <section className={`${cardClass} flex flex-col gap-4`}>
        <div>
          <h2 className="text-base font-bold">Your role: {profile.roleName}</h2>
          {profile.roleDescription && (
            <p className="mt-1 max-w-3xl text-sm text-zinc-500">{profile.roleDescription}</p>
          )}
        </div>
        {groups.length === 0 ? (
          <p className="text-sm text-muted">This role has no permissions yet.</p>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((g) => (
              <div key={g.title}>
                <h3 className="text-[13px] font-semibold text-muted">{g.title}</h3>
                <ul className="mt-1.5 flex flex-col gap-1 text-sm">
                  {g.items.map((i) => (
                    <li key={i.permission} className="flex items-start gap-2">
                      <span aria-hidden="true" className="text-ok">
                        ✓
                      </span>
                      <span>{i.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
