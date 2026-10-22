import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Mail, Lock, User, Loader2, AlertCircle } from "lucide-react";
import { CheckedState } from "@radix-ui/react-checkbox";
import { usePagePocket } from "../hooks/usePagePocket";
import { PagePocketAuthError } from "../background/pagepocket-client";
import { GoogleSignInError } from "../background/google-auth";
import { IS_GOOGLE_SIGN_IN_AVAILABLE } from "../common/pagepocket-mode";
import { Checkbox } from "./Checkbox";

type AuthTab = "login" | "register";

/** Google brand "G" (Identity guidelines) — no icon package carries it. */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="w-4 h-4" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function PagePocketAuth() {
  const { t } = useTranslation();
  const { login, register, googleLogin, isAuthLoading } = usePagePocket();

  const [tab, setTab] = useState<AuthTab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  // easier-auth D2: "Keep me signed in" is pre-checked — the user must
  // actively opt out to get the old session-only (cleared on browser
  // restart) behavior.
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleKeepSignedInChange = (checked: CheckedState) => {
    setKeepSignedIn(checked === true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      if (tab === "login") {
        await login(email, password, keepSignedIn);
      } else {
        await register(email, password, name, keepSignedIn);
      }
    } catch (err) {
      if (err instanceof PagePocketAuthError) {
        setError(err.message || t("filter.cloudAuthError"));
      } else {
        setError(t("filter.cloudAuthError"));
      }
    }
  };

  // easier-auth D4/D7 (task 3.5): the store runs launchWebAuthFlow +
  // POST /api/v1/auth/google; typed GoogleSignInError codes map to
  // friendly, localized messages — never raw provider errors.
  const handleGoogleSignIn = async () => {
    setError(null);

    try {
      await googleLogin(keepSignedIn);
    } catch (err) {
      if (err instanceof GoogleSignInError) {
        setError(
          err.code === "cancelled"
            ? t("filter.cloudGoogleCancelled")
            : t("filter.cloudGoogleFailed"),
        );
      } else if (err instanceof PagePocketAuthError) {
        setError(err.message || t("filter.cloudGoogleFailed"));
      } else {
        setError(t("filter.cloudGoogleFailed"));
      }
    }
  };

  const switchTab = (newTab: AuthTab) => {
    setTab(newTab);
    setError(null);
  };

  return (
    <div className="animate-fade-in space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <Cloud className="w-6 h-6 text-indigo-500" />
        <h2 className="text-lg font-semibold text-slate-900">PagePocket</h2>
      </div>

      {/* Tab selector */}
      <div className="flex border-b border-slate-200">
        <button
          onClick={() => switchTab("login")}
          className={`flex-1 pb-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            tab === "login"
              ? "border-indigo-500 text-indigo-600"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        >
          {t("filter.cloudLogin")}
        </button>
        <button
          onClick={() => switchTab("register")}
          className={`flex-1 pb-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            tab === "register"
              ? "border-indigo-500 text-indigo-600"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        >
          {t("filter.cloudRegister")}
        </button>
      </div>

      {/* Error display */}
      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-3">
        {tab === "register" && (
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("filter.cloudName")}
              required
              className="w-full pl-10 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
        )}

        <div className="relative">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("filter.cloudEmail")}
            required
            className="w-full pl-10 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("filter.cloudPassword")}
            required
            minLength={8}
            className="w-full pl-10 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        {/* easier-auth D2: opt-in persistence, pre-checked (both tabs) */}
        <div className="flex items-center gap-2 px-1">
          <Checkbox
            id="keepSignedIn"
            checked={keepSignedIn}
            onCheckedChange={handleKeepSignedInChange}
          />
          <label
            htmlFor="keepSignedIn"
            className="text-xs text-slate-600 cursor-pointer select-none"
          >
            {t("filter.cloudKeepSignedIn")}
          </label>
        </div>

        <button
          type="submit"
          disabled={isAuthLoading}
          className="w-full flex items-center justify-center gap-2 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          {isAuthLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {tab === "login" ? t("filter.cloudLogin") : t("filter.cloudRegister")}
        </button>

        {/* easier-auth D4/D7: passwordless Google sign-in, shared by both
            tabs; rendered only when VITE_GOOGLE_CLIENT_ID was set at build
            time. The keep-signed-in checkbox above applies to this path
            too. */}
        {IS_GOOGLE_SIGN_IN_AVAILABLE && (
          <>
            <div className="flex items-center gap-3 py-1" role="separator">
              <span className="h-px flex-1 bg-slate-200" />
              <span className="text-xs text-slate-400 select-none">
                {t("filter.cloudOr")}
              </span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={isAuthLoading}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-white text-slate-700 text-sm font-medium rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              {isAuthLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <GoogleIcon />
              )}
              {t("filter.cloudContinueWithGoogle")}
            </button>
          </>
        )}
      </form>

      {/* Switch tab link */}
      <p className="text-xs text-center text-slate-500">
        {tab === "login"
          ? t("filter.cloudNoAccount")
          : t("filter.cloudHasAccount")}{" "}
        <button
          onClick={() => switchTab(tab === "login" ? "register" : "login")}
          className="text-indigo-600 hover:text-indigo-800 font-medium cursor-pointer"
        >
          {tab === "login" ? t("filter.cloudRegister") : t("filter.cloudLogin")}
        </button>
      </p>
    </div>
  );
}
