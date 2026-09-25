"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CircleHelp, X } from "lucide-react";

import styles from "./rulebook-guidance.module.css";

export function RulebookGuidance({ hasMasters, missing }: { hasMasters: boolean; missing: string[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointer = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPointer); };
  }, [open]);

  const setup = [
    ["1", "Review the rule currently in use", "Use the active rule for normal Cash Discount and Turnover Discount work. It cannot be edited directly."],
    ["2", "Update company information", hasMasters ? "Current Tally company information is available for a future rule." : "Update company information from Tally before creating a future rule."],
    ["3", "Create a new rule only when needed", "Choose customer groups, ledgers, products, conversions, and turnover tiers for the new rule."],
    ["4", "Check, then make the new rule active", "Meenakshi checks that all required choices are complete before using the new rule."],
  ];
  return <div className={styles.guidance} ref={root}>
    <button type="button" className={styles.trigger} aria-label={missing.length ? `Show Rulebook guidance (${missing.length} item${missing.length === 1 ? "" : "s"} to complete)` : "Show Rulebook guidance"} title="Rulebook guidance" aria-expanded={open} onClick={() => setOpen((current) => !current)}><CircleHelp size={18} />{missing.length > 0 && <span className={styles.badge} aria-hidden="true">{missing.length}</span>}</button>
    {open && <section className={styles.popover} role="dialog" aria-label="Rulebook guidance">
      <header className={styles.header}><div><p className="eyebrow">Administrator guide</p><h2>Change a rule safely</h2></div><button type="button" className={styles.close} aria-label="Close Rulebook guidance" onClick={() => setOpen(false)}><X size={17} /></button></header>
      <p className={styles.intro}>The active rule remains in use for normal work. Create a new rule only for a real finance-policy change.</p>
      <ol className={styles.steps}>{setup.map(([number, title, detail]) => <li key={number}><span className={styles.number}>{number}</span><div><strong>{title}</strong><small>{detail}</small></div></li>)}</ol>
      {missing.length > 0 && <div className={styles.missing}><AlertTriangle size={16} /><div><strong>Still required before this update can be applied</strong><ul>{missing.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div></div>}
    </section>}
  </div>;
}
