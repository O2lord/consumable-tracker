"use client";

import { useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/ui/Modal";
import { buttonClass, tableClass, tdClass, thClass } from "@/components/ui/styles";

export interface IssueRow {
  reference: string;
  patient: string;
  payment: string;
  overrideReason: string | null;
  collectedBy: string;
  issued: string;
  status: string;
}

export function IssueHistoryButton({ rows, serial }: { rows: IssueRow[]; serial: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="cursor-pointer underline">
        View issue history
      </button>
      {open ? (
        <Modal title="Issued for" onClose={() => setOpen(false)}>
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Reference</th>
                  <th className={thClass}>Patient</th>
                  <th className={thClass}>Payment</th>
                  <th className={thClass}>Collected by</th>
                  <th className={thClass}>Issued</th>
                  <th className={thClass}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.reference}-${i}`}>
                    <td className={tdClass}>{r.reference}</td>
                    <td className={`${tdClass} font-mono`}>{r.patient}</td>
                    <td className={tdClass}>
                      {r.payment}
                      {r.overrideReason ? <span className="block text-xs text-zinc-500">override: {r.overrideReason}</span> : null}
                    </td>
                    <td className={tdClass}>{r.collectedBy}</td>
                    <td className={tdClass}>{r.issued}</td>
                    <td className={tdClass}>{r.status}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td className={tdClass} colSpan={6}>
                      Never issued.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex justify-end">
            <Link href={`/distribution/issue/${encodeURIComponent(serial)}`} className={`${buttonClass} text-sm`}>
              Go to issue page
            </Link>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
