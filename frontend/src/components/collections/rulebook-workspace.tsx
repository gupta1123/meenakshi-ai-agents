"use client";

import { RulebookPage } from "./rulebook";
import type { PageProps } from "./workspace";

export function RulebookWorkspace(props: PageProps) {
  return <RulebookPage {...props} />;
}
