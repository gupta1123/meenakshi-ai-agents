"use client";

import { createContext, useContext, type ReactNode } from "react";

type TallyCompanySelectionValue = {
  selectedCompanyId: string;
  selectCompany: (companyId: string) => void;
};

const TallyCompanySelectionContext = createContext<TallyCompanySelectionValue | null>(null);

export function TallyCompanySelectionProvider({ children, selectedCompanyId, selectCompany }: TallyCompanySelectionValue & { children: ReactNode }) {
  return <TallyCompanySelectionContext.Provider value={{ selectedCompanyId, selectCompany }}>{children}</TallyCompanySelectionContext.Provider>;
}

export function useTallyCompanySelection() {
  const context = useContext(TallyCompanySelectionContext);
  if (!context) throw new Error("useTallyCompanySelection must be used inside TallyCompanySelectionProvider.");
  return context;
}
