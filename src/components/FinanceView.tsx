"use client";

// ============================================================
// FINANZAS — contenedor con sub-pestañas:
//   Resumen        → FinancePanel (P&L real del periodo)
//   Calculadora COD → CodCalculatorPanel (unit economics, cliente puro)
//   Costes         → CostsPanel (editor de product_costs)
// Cada hijo gestiona su propio scroll: aquí solo vive la tira de chips.
// ============================================================

import { useState } from "react";
import { Chip } from "./ui";
import FinancePanel from "./FinancePanel";
import CodCalculatorPanel from "./CodCalculatorPanel";
import CostsPanel from "./CostsPanel";

type FinanceTab = "resumen" | "calculadora" | "costes";

const TABS: Array<{ id: FinanceTab; label: string }> = [
  { id: "resumen", label: "Resumen" },
  { id: "calculadora", label: "Calculadora COD" },
  { id: "costes", label: "Costes" },
];

export default function FinanceView() {
  const [tab, setTab] = useState<FinanceTab>("resumen");

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 md:px-8 pt-4">
        <div className="max-w-5xl mx-auto w-full flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <Chip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </Chip>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "resumen" ? <FinancePanel /> : tab === "calculadora" ? <CodCalculatorPanel /> : <CostsPanel />}
      </div>
    </div>
  );
}
