// Galería interna del sistema de diseño. SOLO en desarrollo: en producción
// responde 404 (no existe para el operador ni para nadie).
import { notFound } from "next/navigation";
import DesignSystemGallery from "../../components/DesignSystemGallery";

export const dynamic = "force-dynamic";

export default function DesignSystemPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DesignSystemGallery />;
}
