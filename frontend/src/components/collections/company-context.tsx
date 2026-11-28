"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { usePathname } from "next/navigation";
import type { Bootstrap, Company, EvaluationRun, Organization } from "./types";

type CompanyContextValue = {
  company: Company;
  organization: Organization;
  availableCompanies: Array<{ company: Company; organization: Organization }>;
  isAdministrator: boolean;
  isFinanceApprover: boolean;
  companyKey: number;
  pendingRunView: { current: { run: EvaluationRun; isLatest: boolean } | null };
  /** A split company's years are one company; this moves the working year without changing the dropdown. */
  setWorkingYear: (companyId: string | null) => void;
};

const CompanyContext = createContext<CompanyContextValue | null>(null);

export function CompanyProvider({ bootstrap, initialCompanyId, children }: { bootstrap: Bootstrap; initialCompanyId: string; children: ReactNode }) {
  const companies = useMemo(() => bootstrap.organizations.flatMap((organization) => organization.companies.map((company) => ({ company, organization }))), [bootstrap]);
  const [companyId, setCompanyId] = useState(initialCompanyId);
  const [companyKey, setCompanyKey] = useState(0);
  const [yearOverride, setYearOverride] = useState<string | null>(null);
  const pathname = usePathname();
  const pendingRunView = useRef<{ run: EvaluationRun; isLatest: boolean } | null>(null);
  const yearRef = useRef<string | null>(null);
  const setWorkingYear = useCallback((id: string | null) => {
    if (yearRef.current === id) return;
    yearRef.current = id;
    setYearOverride(id);
    setCompanyKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (pathname !== "/turnover-discount") {
      pendingRunView.current = null;
      setWorkingYear(null);
    }
  }, [pathname, setWorkingYear]);

  useEffect(() => {
    const valid = companies.find((item) => item.company.id === initialCompanyId) ?? companies[0];
    const nextCompanyId = valid?.company.id ?? "";
    if (nextCompanyId && nextCompanyId !== companyId) {
      setCompanyId(nextCompanyId);
      setCompanyKey((key) => key + 1);
    }
  }, [companies, companyId, initialCompanyId]);

  const base = companies.find((item) => item.company.id === companyId) ?? companies[0];
  // The override only ever points at another year of the chosen company.
  const selected = (yearOverride && base?.company.year_members?.some((member) => member.id === yearOverride) ? companies.find((item) => item.company.id === yearOverride) : null) ?? base;
  if (!selected) return null;

  const value: CompanyContextValue = {
    company: selected.company,
    organization: selected.organization,
    availableCompanies: companies,
    isAdministrator: selected.organization.roles.includes("administrator"),
    isFinanceApprover: selected.organization.roles.includes("finance_approver"),
    companyKey,
    pendingRunView,
    setWorkingYear,
  };

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompany() {
  const context = useContext(CompanyContext);
  if (!context) throw new Error("useCompany must be used inside CompanyProvider.");
  return context;
}
