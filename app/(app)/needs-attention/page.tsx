import { requireSession } from "@/server/auth/session";
import { NeedsAttentionList } from "./NeedsAttentionList";

export const metadata = { title: "Needs attention" };

export default async function NeedsAttentionPage() {
  await requireSession();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Needs attention</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Scans made on this device that could not be applied. This list lives on this device only.
        </p>
      </div>
      <NeedsAttentionList />
    </div>
  );
}
