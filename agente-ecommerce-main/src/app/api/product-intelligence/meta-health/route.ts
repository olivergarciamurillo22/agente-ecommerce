import { NextResponse } from "next/server";
import { MetaAdLibraryProvider } from "@/lib/product-intelligence/providers/meta-ad-library-provider";
import { saveProviderHealth } from "@/lib/product-intelligence/state";
import { productIntelligenceEnabled } from "@/lib/product-intelligence/config";

export const dynamic = "force-dynamic";
export async function POST() {
  if (!productIntelligenceEnabled()) return NextResponse.json({ status: "DISABLED" }, { status: 503 });
  const health = await new MetaAdLibraryProvider().healthCheck(); saveProviderHealth(health);
  return NextResponse.json({ status: health.code, authorization: health.authorization, reason: health.reason });
}
