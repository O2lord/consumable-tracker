import { requirePermission } from "@/server/auth/session";
import { LabelCheck } from "./LabelCheck";

export const metadata = { title: "Label check" };

export default async function LabelCheckPage() {
  await requirePermission("check_labels");
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Label check</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Scan any printed bottle or box label to confirm the scanner reads it correctly and the system
          recognises it. Nothing is changed.
        </p>
      </div>
      <LabelCheck />
    </div>
  );
}
