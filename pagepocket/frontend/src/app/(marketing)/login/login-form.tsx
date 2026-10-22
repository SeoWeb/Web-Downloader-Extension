"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/ui/form";
import { validateRedirect } from "@/lib/auth/redirect";
import {
  GoogleButton,
  OAuthDivider,
} from "@/components/marketing/google-button";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

type LoginValues = z.infer<typeof loginSchema>;

/** Callback-reported Google outcomes (easier-auth D9) → form-banner text. */
const GOOGLE_ERRORS: Record<string, string> = {
  google: "Google sign-in failed. Please try again.",
  google_cancelled: "Google sign-in was cancelled.",
};

export default function LoginForm({
  googleEnabled,
}: {
  googleEnabled: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [serverError, setServerError] = useState<string | null>(
    () => GOOGLE_ERRORS[searchParams.get("error") ?? ""] ?? null,
  );
  const [rateLimitSeconds, setRateLimitSeconds] = useState<number | null>(null);

  const clearRateLimit = useCallback(() => setRateLimitSeconds(null), []);

  useEffect(() => {
    if (rateLimitSeconds === null) return;
    if (rateLimitSeconds <= 0) {
      clearRateLimit();
      return;
    }
    const id = setTimeout(
      () => setRateLimitSeconds((s) => (s !== null ? s - 1 : null)),
      1000,
    );
    return () => clearTimeout(id);
  }, [rateLimitSeconds, clearRateLimit]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: searchParams.get("email") ?? "",
    },
  });

  async function onSubmit(data: LoginValues) {
    setServerError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 401) {
          setServerError("Invalid email or password");
          return;
        }
        if (res.status === 429) {
          const retryAfter = Number(body.retry_after ?? 60);
          setRateLimitSeconds(retryAfter);
          return;
        }
        setServerError(body.error ?? "Something went wrong");
        return;
      }

      const redirect = validateRedirect(searchParams.get("redirect"));
      router.push(redirect);
    } catch {
      setServerError("Network error — please try again");
    }
  }

  // Thread the post-login target into the server-side OAuth start route so
  // Google sign-in lands where password login would.
  const redirectParam = searchParams.get("redirect");
  const googleHref = redirectParam
    ? `/api/auth/google/start?redirect=${encodeURIComponent(redirectParam)}`
    : "/api/auth/google/start";

  return (
    <div className="flex min-h-[calc(100vh-8rem)] items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Welcome back to PagePocket
          </p>
        </div>

        {googleEnabled && (
          <>
            <GoogleButton href={googleHref} />
            <OAuthDivider />
          </>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              {...register("email")}
            />
            {errors.email && (
              <p className="text-destructive text-sm">{errors.email.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              {...register("password")}
            />
            {errors.password && (
              <p className="text-destructive text-sm">
                {errors.password.message}
              </p>
            )}
          </div>

          {serverError && <FormError message={serverError} />}

          {rateLimitSeconds !== null && rateLimitSeconds > 0 && (
            <p className="text-destructive text-sm">
              Too many attempts — try again in {rateLimitSeconds} second
              {rateLimitSeconds !== 1 ? "s" : ""}
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={
              isSubmitting ||
              (rateLimitSeconds !== null && rateLimitSeconds > 0)
            }
          >
            {isSubmitting ? "Signing in..." : "Sign in"}
          </Button>
        </form>

        <p className="text-muted-foreground text-center text-sm">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="text-primary hover:underline">
            Sign up
          </Link>
        </p>

        <p className="text-center">
          <Link
            href="/forgot-password"
            className="text-muted-foreground text-xs hover:underline"
          >
            Forgot your password?
          </Link>
        </p>
      </div>
    </div>
  );
}
