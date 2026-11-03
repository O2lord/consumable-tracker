"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { inputClass } from "@/components/ui/styles";

/**
 * A search box for a list page. What is typed goes in the URL as ?q= (after a short pause), and the page reads it and
 * filters on the server. Other query values (a tab, a filter) are kept, and the page number starts over.
 */
export function ListSearch({
  placeholder = "Search",
  param = "q",
  className = "",
}: {
  placeholder?: string;
  param?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get(param) ?? "";
  const [value, setValue] = useState(current);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the URL when it changes from outside (back button, a link that clears the search).
  useEffect(() => {
    setValue(current);
  }, [current]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const push = (next: string) => {
    const qs = new URLSearchParams(searchParams.toString());
    const trimmed = next.trim();
    if (trimmed) qs.set(param, trimmed);
    else qs.delete(param);
    qs.delete("page");
    const s = qs.toString();
    startTransition(() => router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false }));
  };

  const onChange = (next: string) => {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => push(next), 250);
  };

  return (
    <div className={`relative ${className}`}>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (timer.current) clearTimeout(timer.current);
            push(value);
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        className={`${inputClass} w-full ${pending ? "opacity-80" : ""}`}
      />
    </div>
  );
}
