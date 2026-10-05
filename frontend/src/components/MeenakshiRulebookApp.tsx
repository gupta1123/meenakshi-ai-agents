"use client";

import { WorkspaceEntry } from "@/components/collections/workspace";
import { useWorkspaceSession } from "@/components/collections/workspace-session";
import type { CollectionsPage } from "@/components/collections/types";

export type { CollectionsPage } from "@/components/collections/types";

export function MeenakshiRulebookApp({ page = "control-centre" }: { page?: CollectionsPage }) {
  const { email, signOut } = useWorkspaceSession();
  return <WorkspaceEntry page={page} email={email} signOut={signOut} />;
}
