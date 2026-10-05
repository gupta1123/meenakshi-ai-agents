"use client";

import type { ReactNode } from "react";

import { AuthGate } from "./auth-gate";
import { WorkspaceSessionProvider } from "./workspace-session";

/** Persists authentication, company readiness, and workspace data across route changes. */
export function CollectionsAppProvider({ children }: { children: ReactNode }) {
  return <AuthGate>{({ email, signOut }) => <WorkspaceSessionProvider email={email} signOut={signOut}>{children}</WorkspaceSessionProvider>}</AuthGate>;
}
