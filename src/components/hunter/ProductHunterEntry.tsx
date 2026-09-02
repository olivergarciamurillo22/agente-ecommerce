"use client";

// Punto de entrada del Cazador de productos. Carga el módulo real de forma
// perezosa (no bloquea el primer render del panel) y muestra un skeleton
// mientras llega. Si el módulo no está disponible, lo dice — sin inventar.
import { lazy, Suspense } from "react";
import { SkeletonRows } from "../ui";

const ProductHunterView = lazy(() => import("./ProductHunterView"));

export default function ProductHunterEntry() {
  return (
    <Suspense
      fallback={
        <div className="h-full overflow-y-auto px-4 md:px-8 py-6">
          <div className="max-w-[1280px]">
            <SkeletonRows rows={6} />
          </div>
        </div>
      }
    >
      <ProductHunterView />
    </Suspense>
  );
}
