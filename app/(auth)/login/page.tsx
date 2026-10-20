import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/session";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">
        <h1 className="mb-1 text-[22px] font-bold tracking-tight text-side-title">Consumables Tracker</h1>
        <p className="mb-6 text-sm text-muted">Sign in with your staff ID.</p>
        <Suspense fallback={null}>
          <SignedInRedirect />
        </Suspense>
        <LoginForm />
      </div>
    </main>
  );
}

// Anyone who is already signed in goes straight to the dashboard. This reads the session cookie,
// so it sits in its own Suspense boundary and the form itself can be prerendered.
async function SignedInRedirect() {
  if (await getSession()) redirect("/dashboard");
  return null;
}
