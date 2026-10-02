import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Mail, Lock, User, Loader2, AlertCircle } from "lucide-react";
import { usePagePocket } from "../hooks/usePagePocket";
import { PagePocketAuthError } from "../background/pagepocket-client";

type AuthTab = "login" | "register";

export function PagePocketAuth() {
  const { t } = useTranslation();
  const { login, register, isAuthLoading } = usePagePocket();

  const [tab, setTab] = useState<AuthTab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      if (tab === "login") {
        await login(email, password);
      } else {
        await register(email, password, name);
      }
    } catch (err) {
      if (err instanceof PagePocketAuthError) {
        setError(err.message || t("filter.cloudAuthError"));
      } else {
        setError(t("filter.cloudAuthError"));
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

        <button
          type="submit"
          disabled={isAuthLoading}
          className="w-full flex items-center justify-center gap-2 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          {isAuthLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {tab === "login" ? t("filter.cloudLogin") : t("filter.cloudRegister")}
        </button>
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
