import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { BottleSearch } from "./BottleSearch";

export const metadata = { title: "Bottle history" };

export default async function BottleSearchPage({ searchParams }: { searchParams: Promise<{ serial?: string }> }) {
  await requirePermission("view_reports");
  const { serial } = await searchParams;
  if (serial?.trim()) redirect(`/reports/bottle/${encodeURIComponent(serial.trim().toUpperCase())}`);

  return (
    <div className="flex max-w-md flex-col gap-4">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Bottle history</h1>
        <p className="mt-1 text-sm text-zinc-500">Scan or type a serial to see everything that has happened to it.</p>
      </div>
      <BottleSearch />
    </div>
  );
}
