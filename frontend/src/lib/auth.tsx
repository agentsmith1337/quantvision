"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { apiGet, apiPost, UNAUTHORIZED_EVENT } from "./api";
import { marketSocket } from "./market-socket";

export type AuthStatus = {
  setup_complete: boolean;
  signed_in: boolean;
  user: { username: string; has_avatar: boolean } | null;
  env_credentials_available: boolean;
};

type AuthContextValue = {
  status: AuthStatus | null; // null while loading
  error: string | null;
  refresh: () => Promise<AuthStatus | null>;
  signOut: () => Promise<void>;
  avatarVersion: number;
  bumpAvatar: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarVersion, setAvatarVersion] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const s = await apiGet<AuthStatus>("/api/auth/status");
      setStatus(s);
      setError(null);
      // The market socket is authenticated by the session cookie; reconnect on change.
      marketSocket.setEnabled(s.signed_in);
      return s;
    } catch {
      setError("Can't reach the QuantVision engine. Is it running? (python run.py)");
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiGet<AuthStatus>("/api/auth/status")
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        marketSocket.setEnabled(s.signed_in);
      })
      .catch(() => !cancelled && setError("Can't reach the QuantVision engine. Is it running? (python run.py)"));
    const onUnauthorized = () => void refresh();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await apiPost("/api/auth/signout");
    } finally {
      await refresh();
    }
  }, [refresh]);

  const bumpAvatar = useCallback(() => setAvatarVersion((v) => v + 1), []);

  return <AuthContext.Provider value={{ status, error, refresh, signOut, avatarVersion, bumpAvatar }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
