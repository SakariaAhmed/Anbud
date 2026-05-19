"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { LockKeyhole, LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function safeNextPath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/api/") || value.startsWith("/login")) {
    return "/";
  }

  return value;
}

export function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password,
          next: safeNextPath(nextPath),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        redirectTo?: string;
      };

      if (!response.ok) {
        setError(payload.error || "Could not sign in.");
        return;
      }

      router.replace(safeNextPath(payload.redirectTo || nextPath));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-white">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-lg bg-white">
            <Image
              src="/bidsite-logo.png"
              alt=""
              width={44}
              height={60}
              aria-hidden="true"
              priority
              className="h-10 w-auto"
            />
          </span>
          <div>
            <p className="text-lg font-semibold leading-none">bidsite</p>
            <p className="mt-1 text-sm text-slate-400">Protected workspace</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="rounded-lg border border-white/10 bg-white/[0.06] p-5 shadow-2xl">
          <div className="mb-5 flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-md bg-slate-800 text-slate-100">
              <LockKeyhole className="size-4" />
            </span>
            <h1 className="text-xl font-semibold">Enter password</h1>
          </div>

          <div className="space-y-2">
            <Label htmlFor="access-password" className="text-slate-200">
              Password
            </Label>
            <Input
              id="access-password"
              type="password"
              value={password}
              autoComplete="current-password"
              autoFocus
              required
              onChange={(event) => setPassword(event.target.value)}
              className="h-10 border-white/15 bg-slate-950/60 text-white placeholder:text-slate-500"
            />
          </div>

          {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}

          <Button type="submit" className="mt-5 w-full" disabled={loading}>
            <LogIn data-icon="inline-start" />
            {loading ? "Signing in ..." : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
  );
}
