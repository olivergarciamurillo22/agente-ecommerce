import { NextResponse } from "next/server";
import { dropeaCreateModeSummary } from "@/lib/suppliers/dropea/create-gate";
import { listSupplierProductMappings } from "@/lib/db";
import {
  supplierSyncEnabled,
  supplierPilotMode,
  legacyIntegrationsDisabled,
} from "@/lib/suppliers/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Estado de la integración con proveedores, para que Pedro vea por qué
 *  un pedido no sale a Dropea sin tener que mirar el .env. */
export async function GET(): Promise<NextResponse> {
  const dropea = dropeaCreateModeSummary();
  return NextResponse.json({
    supplierSyncEnabled: supplierSyncEnabled(),
    pilotMode: supplierPilotMode(),
    legacyIntegrationsDisabled: legacyIntegrationsDisabled(),
    dropea: {
      ...dropea,
      connected: dropea.apiEnabled,
      mappings: listSupplierProductMappings("dropea").length,
    },
  });
}
