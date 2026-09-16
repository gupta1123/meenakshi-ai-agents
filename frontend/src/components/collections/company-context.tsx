"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { Bootstrap, Company, Organization } from "./types";

type CompanyContextValue = {
  company: Company;
  organization: Organization;
  availableCompanies: Array<{ company: Company; organization: Organization }>;
  isAdministrator: boolean;
  isFinanceApprover: boolean;
  companyKey: number;
};

const CompanyContext = createContext<CompanyContextValue | null>(null);

export function CompanyProvider({ bootstrap, initialCompanyId, children }: { bootstrap: Bootstrap; initialCompanyId: string; children: ReactNode }) {
  const companies = useMemo(() => bootstrap.organizations.flatMap((organization) => organization.companies.map((company) => ({ company, organization }))), [bootstrap]);
  const [companyId, setCompanyId] = useState(initialCompanyId);
  const [companyKey, setCompanyKey] = useState(0);

  useEffect(() => {
    const valid = companies.find((item) => item.company.id === initialCompanyId) ?? companies[0];
    const nextCompanyId = valid?.company.id ?? "";
    if (nextCompanyId && nextCompanyId !== companyId) {
      setCompanyId(nextCompanyId);
      setCompanyKey((key) => key + 1);
    }
  }, [companies, companyId, initialCompanyId]);

  const selected = companies.find((item) => item.company.id === companyId) ?? companies[0];
  if (!selected) return null;

  const value: CompanyContextValue = {
    company: selected.company,
    organization: selected.organization,
    availableCompanies: companies,
    isAdministrator: selected.organization.roles.includes("administrator"),
    isFinanceApprover: selected.organization.roles.includes("finance_approver"),
    companyKey,
  };

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompany() {
  const context = useContext(CompanyContext);
  if (!context) throw new Error("useCompany must be used inside CompanyProvider.");
  return context;
}
