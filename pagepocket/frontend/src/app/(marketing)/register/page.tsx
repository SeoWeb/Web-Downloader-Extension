import { Suspense } from "react";
import { env } from "@/lib/env";
import RegisterForm from "./register-form";

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm googleEnabled={Boolean(env.GOOGLE_CLIENT_ID)} />
    </Suspense>
  );
}
