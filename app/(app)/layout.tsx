import { Suspense } from "react";
import { connection } from "next/server";
import { getSession, requireSession, ServiceUnavailableError } from "@/server/auth/session";
import { navFor } from "@/server/auth/permissions";
import { SyncStatus } from "@/components/offline/SyncStatus";
import { OfflineNotice } from "@/components/offline/OfflineNotice";
import { SidebarBrand, SidebarFrame, SidebarNav, SidebarToggle, type SidebarGroup } from "@/components/nav/SidebarNav";
import { UserMenu } from "@/components/nav/UserMenu";
import { PageLoading } from "@/components/ui/PageLoading";
import { ToastProvider } from "@/components/ui/Toast";
import { logoutAction } from "./actions";

// Everything under (app) needs a signed-in, active user. Pages check their own permission with
// requirePermission(); this layout decides which links to show.
// The session lives in a cookie, so the parts that read it sit in small Suspense boundaries and
// the frame around them (sidebar, top bar, main) stays static.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <SidebarFrame
        sidebar={
          <Suspense fallback={<SidebarBrand />}>
            <SidebarMenu />
          </Suspense>
        }
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center gap-4 px-4 pt-4 pb-1 md:px-6">
            <SidebarToggle />
            <Suspense fallback={<div className="flex-1" />}>
              <TopBar />
            </Suspense>
          </header>
          <main className="flex-1 p-4 md:px-6">
            <Suspense fallback={<PageLoading />}>
              <SessionGate>{children}</SessionGate>
            </Suspense>
          </main>
        </div>
      </SidebarFrame>
    </ToastProvider>
  );
}

/** Blocks the page content until the visitor is known to be signed in. */
async function SessionGate({ children }: { children: React.ReactNode }) {
  // The session is per-request, so never prerender this.
  await connection();
  try {
    await requireSession();
  } catch (e) {
    // Offline or Supabase unreachable: show a notice instead of throwing, so no error screen appears.
    if (e instanceof ServiceUnavailableError) return <OfflineNotice />;
    throw e;
  }
  return <>{children}</>;
}

/** For the chrome around the page: offline just means no menu, SessionGate shows the notice. */
async function getSessionOrNull() {
  // Opt into request-time rendering before anything that could read the clock. SidebarMenu and
  // TopBar both come through here, and each sits inside its own Suspense boundary.
  await connection();
  try {
    return await getSession();
  } catch (e) {
    if (e instanceof ServiceUnavailableError) return null;
    throw e;
  }
}

// Links are grouped by where their page lives. The dashboard sits with the store screens.
const GROUPS: { title: string; prefixes: string[] }[] = [
  { title: "Store", prefixes: ["/dashboard", "/store"] },
  { title: "Distribution", prefixes: ["/distribution"] },
  { title: "Reports", prefixes: ["/reports"] },
  { title: "Admin", prefixes: ["/admin"] },
];

async function SidebarMenu() {
  // Does not redirect: SessionGate is the one place that sends signed-out visitors to /login.
  const session = await getSessionOrNull();
  if (!session) return <SidebarBrand />;
  const nav = navFor(session.role);

  const groups: SidebarGroup[] = GROUPS.map((g) => ({
    title: g.title,
    items: nav
      .filter((item) => g.prefixes.some((p) => item.href === p || item.href.startsWith(`${p}/`)))
      .map(({ label, href }) => ({ label, href })),
  })).filter((g) => g.items.length > 0);

  return <SidebarNav groups={groups} />;
}

async function TopBar() {
  // Does not redirect: SessionGate handles signed-out visitors.
  const session = await getSessionOrNull();
  if (!session) return <div className="flex-1" />;

  return (
    <>
      <SyncStatus userId={session.userId} />
      <div className="flex-1" />
      <UserMenu name={session.name} roleName={session.roleName} logoutAction={logoutAction} />
    </>
  );
}
