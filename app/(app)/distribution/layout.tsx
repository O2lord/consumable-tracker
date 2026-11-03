import type { ReactNode } from "react";
import { requireSession } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { ISSUE_AND_RETURN_TABS } from "@/lib/issue-return-tabs";
import { DistributionTabsProvider } from "@/components/nav/DistributionTabs";

export default async function DistributionLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const tabs = ISSUE_AND_RETURN_TABS.filter((t) => can(session.role, t.permission)).map(({ label, href }) => ({ label, href }));
  return <DistributionTabsProvider tabs={tabs}>{children}</DistributionTabsProvider>;
}
