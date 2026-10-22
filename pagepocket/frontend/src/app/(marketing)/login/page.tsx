import { Suspense } from "react";
import { env } from "@/lib/env";
import LoginForm from "./login-form";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm googleEnabled={Boolean(env.GOOGLE_CLIENT_ID)} />
    </Suspense>
  );
}
