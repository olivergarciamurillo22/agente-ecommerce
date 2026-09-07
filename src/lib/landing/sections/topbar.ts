import type { ProductCandidate } from "../../hunter/types";
export function topbar(c:ProductCandidate):string{return `<section class="topbar" data-bloque="topbar"><p>Pago contra reembolso · Confirmación antes del envío${c.scoring?` · ${c.scoring.shippingEur.toFixed(2).replace(".",",")} € de envío`:""}</p></section>`;}
