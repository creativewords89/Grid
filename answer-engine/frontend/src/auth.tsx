import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, setCsrfToken, type Me, type User } from "./api";

type AuthState = {
  user: User | null;
  loading: boolean;
  signedIn: (me: Me) => void;
  updated: (user: User) => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const signedIn = useCallback((me: Me) => {
    setCsrfToken(me.csrf_token);
    setUser(me.user);
  }, []);

  useEffect(() => {
    api
      .me()
      .then(signedIn)
      .catch((error: unknown) => {
        if (!(error instanceof ApiError) || error.status !== 401) console.error(error);
      })
      .finally(() => setLoading(false));
  }, [signedIn]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setCsrfToken("");
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signedIn, updated: setUser, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) throw new Error("useAuth must be used inside <AuthProvider>");
  return state;
}
