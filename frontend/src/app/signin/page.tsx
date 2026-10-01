"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function SignInPage() {
  const { status, refresh } = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/auth/signin", { username, password });
      await refresh();
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
      setBusy(false);
    }
  };

  const input = "mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm outline-none focus:border-accent";

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" className="size-14 rounded-xl" />
          <h1 className="font-display text-2xl font-semibold tracking-tight">Sign in to QuantVision</h1>
          <p className="text-sm text-muted">Your password also unlocks your encrypted broker credentials.</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-surface p-6">
          <label className="block text-sm">
            User ID
            <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className={input} />
          </label>
          <label className="block text-sm">
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
          </label>
          {error && <p className="text-sm text-down">{error}</p>}
          <button type="submit" disabled={busy || !username || !password} className="w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-accent-fg disabled:opacity-60">
            {busy ? "Unlocking…" : "Sign in"}
          </button>
        </form>
        <div className="mt-4 text-center text-sm">
          {status?.setup_complete ? (
            <span className="text-muted">Forgot your password? Delete quantvision.db in your QuantVision folder to start over.</span>
          ) : (
            <Link href="/setup/" className="font-medium text-accent hover:underline">
              Sign up / Initial setup
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
