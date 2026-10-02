"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const registerSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    email: z.string().email("Enter a valid email"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

type RegisterValues = z.infer<typeof registerSchema>;

function getPasswordStrength(password: string): {
  label: string;
  color: string;
} {
  if (password.length === 0) return { label: "", color: "" };
  if (password.length < 8) return { label: "Too short", color: "text-destructive" };
  const hasUpper = /[A-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  const score = [hasUpper, hasNumber, hasSpecial].filter(Boolean).length;
  if (score === 0) return { label: "Weak", color: "text-destructive" };
  if (score <= 1) return { label: "Fair", color: "text-yellow-600" };
  if (score <= 2) return { label: "Good", color: "text-green-600" };
  return { label: "Strong", color: "text-green-700" };
}

export default function RegisterPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [conflictEmail, setConflictEmail] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
  });

  const password = watch("password", "");
  const strength = getPasswordStrength(password);

  async function onSubmit(data: RegisterValues) {
    setServerError(null);
    setConflictEmail(null);
    try {
      const res = await fetch("/api/session/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          email: data.email,
          password: data.password,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          setServerError("An account with this email already exists");
          setConflictEmail(data.email);
          return;
        }
        setServerError(body.error ?? "Something went wrong");
        return;
      }

      router.push("/app/onboarding");
    } catch {
      setServerError("Network error — please try again");
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-8rem)] items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Create an account</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Start saving and organising web pages
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="Jane Doe"
              {...register("name")}
            />
            {errors.name && (
              <p className="text-destructive text-sm">{errors.name.message}</p>
            )}
          </div>

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
            {password.length > 0 && (
              <p className={`text-xs ${strength.color}`}>
                Strength: {strength.label}
              </p>
            )}
            {errors.password && (
              <p className="text-destructive text-sm">
                {errors.password.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <Input
              id="confirmPassword"
              type="password"
              placeholder="••••••••"
              {...register("confirmPassword")}
            />
            {errors.confirmPassword && (
              <p className="text-destructive text-sm">
                {errors.confirmPassword.message}
              </p>
            )}
          </div>

          {serverError && (
            <div className="text-destructive text-sm">
              <p>{serverError}</p>
              {conflictEmail && (
                <p className="mt-1">
                  <Link
                    href={`/login?email=${encodeURIComponent(conflictEmail)}`}
                    className="text-primary hover:underline"
                  >
                    Sign in instead
                  </Link>
                </p>
              )}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Creating account..." : "Create account"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
