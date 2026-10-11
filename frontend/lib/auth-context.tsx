"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  type User,
} from "firebase/auth";
import { auth } from "./firebase";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    setPersistence(auth, browserLocalPersistence)
      .then(() => {
        if (!active) return;
        unsubscribe = onAuthStateChanged(
          auth,
          (nextUser) => {
            setUser(nextUser);
            setLoading(false);
          },
          () => {
            setUser(null);
            setLoading(false);
          },
        );
      })
      .catch(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }
  return context;
}