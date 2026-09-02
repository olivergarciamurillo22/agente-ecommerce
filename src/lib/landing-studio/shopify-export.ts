import { validateLandingBlueprint } from "./validation";
import type { LandingBlueprint, LandingSection } from "./types";

export interface ShopifyThemeFile {
  path: string;
  content: string;
}

export interface ShopifyThemeBundle {
  name: string;
  files: ShopifyThemeFile[];
  manifest: {
    schemaVersion: 1;
    blueprintId: string;
    candidateId: string;
    generatedAt: string;
    published: false;
    entryTemplate: string;
    files: string[];
  };
}

function slug(value: string): string {
  const cleaned = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return cleaned.slice(0, 40) || "producto";
}

function schemaFor(section: LandingSection): Record<string, unknown> {
  const settings: Array<Record<string, unknown>> = [
    { type: "text", id: "eyebrow", label: "Antetítulo", default: section.eyebrow.slice(0, 80) || "Información" },
    { type: "text", id: "heading", label: "Título", default: section.title.slice(0, 120) || "Título" },
    { type: "richtext", id: "body", label: "Texto", default: `<p>${section.body.replace(/[<>]/g, "") || "Texto de la sección"}</p>` },
    { type: "image_picker", id: "image", label: "Imagen" },
    { type: "video", id: "video", label: "Vídeo" },
    { type: "product", id: "product", label: "Producto" },
    { type: "color_scheme", id: "color_scheme", label: "Esquema de color", default: "scheme-1" },
    { type: "font_picker", id: "heading_font", label: "Tipografía del título", default: "assistant_n4" },
  ];
  return {
    name: `Casamable · ${section.title.slice(0, 30) || section.type}`,
    tag: "section",
    class: "cm-landing-section",
    settings,
    blocks: [
      { type: "item", name: "Elemento", settings: [{ type: "text", id: "text", label: "Texto", default: "Contenido" }] },
    ],
    max_blocks: 12,
    presets: [{ name: `Casamable · ${section.type}`, blocks: section.items.slice(0, 6).map((item) => ({ type: "item", settings: { text: item.slice(0, 180) } })) }],
  };
}

function liquidFor(section: LandingSection): string {
  const schema = JSON.stringify(schemaFor(section), null, 2);
  return `{% comment %}Generated from LandingBlueprint ${section.id}. Edit settings in Shopify; regenerate from Casamable for structural changes.{% endcomment %}
<div id="cm-{{ section.id }}" class="cm-section cm-section--${section.type} color-{{ section.settings.color_scheme }} gradient">
  <div class="cm-section__inner">
    {% if section.settings.eyebrow != blank %}<p class="cm-section__eyebrow">{{ section.settings.eyebrow | escape }}</p>{% endif %}
    <h2 class="cm-section__heading">{{ section.settings.heading | escape }}</h2>
    <div class="cm-section__body rte">{{ section.settings.body }}</div>
    {% if section.settings.video != blank %}{{ section.settings.video | video_tag: controls: true, class: 'cm-section__media' }}
    {% elsif section.settings.image != blank %}{{ section.settings.image | image_url: width: 1600 | image_tag: loading: 'lazy', class: 'cm-section__media', widths: '480, 760, 1100, 1600' }}{% endif %}
    {% if section.blocks.size > 0 %}<ul class="cm-section__items" role="list">
      {% for block in section.blocks %}<li class="cm-section__item" {{ block.shopify_attributes }}>{{ block.settings.text | escape }}</li>{% endfor %}
    </ul>{% endif %}
    {% if section.settings.product != blank %}<a class="cm-section__cta" href="{{ section.settings.product.url }}">{{ '${section.type === "offer" ? "Pedir contrareembolso" : "Ver producto"}' | escape }}</a>{% endif %}
  </div>
</div>
<style>
  #cm-{{ section.id }} { --cm-heading-font: {{ section.settings.heading_font.family }}, {{ section.settings.heading_font.fallback_families }}; }
  #cm-{{ section.id }} .cm-section__heading { font-family: var(--cm-heading-font); }
</style>
{% schema %}
${schema}
{% endschema %}
`;
}

const SHARED_CSS = `.cm-section{padding:clamp(3rem,7vw,6.5rem) 1.25rem;background:rgb(var(--color-background));color:rgb(var(--color-foreground))}.cm-section__inner{width:min(1120px,100%);margin:0 auto}.cm-section__eyebrow{margin:0 0 .75rem;font-size:.75rem;font-weight:650;letter-spacing:.12em;text-transform:uppercase;opacity:.66}.cm-section__heading{max-width:18ch;margin:0;font-size:clamp(2rem,5vw,4.75rem);line-height:1.02;letter-spacing:-.035em}.cm-section__body{max-width:62ch;margin-top:1.25rem;font-size:clamp(1rem,2vw,1.2rem);line-height:1.65}.cm-section__media{display:block;width:100%;max-height:680px;margin-top:2rem;border-radius:12px;object-fit:cover}.cm-section__items{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;margin:2rem 0 0;padding:1px;list-style:none;background:rgba(var(--color-foreground),.12)}.cm-section__item{padding:1.25rem;background:rgb(var(--color-background))}.cm-section__cta{display:inline-flex;min-height:48px;align-items:center;justify-content:center;margin-top:1.75rem;padding:.75rem 1.25rem;border-radius:8px;background:rgb(var(--color-foreground));color:rgb(var(--color-background));text-decoration:none;font-weight:650}.cm-section--offer{text-align:center}.cm-section--offer .cm-section__heading,.cm-section--offer .cm-section__body{margin-left:auto;margin-right:auto}@media(max-width:749px){.cm-section{padding:3rem 1rem}.cm-section__items{grid-template-columns:1fr}.cm-section__heading{font-size:clamp(2rem,11vw,3.25rem)}}`;
const SHARED_JS = `document.addEventListener('click',function(event){const link=event.target.closest('.cm-section__cta');if(!link)return;document.dispatchEvent(new CustomEvent('casamable:landing-cta',{detail:{href:link.href}}));});`;

export function buildShopifyThemeBundle(blueprint: LandingBlueprint, now = new Date().toISOString()): ShopifyThemeBundle {
  const blockers = validateLandingBlueprint(blueprint).filter((issue) => issue.severity === "blocker");
  if (blockers.length > 0) throw new Error(`Exportación bloqueada: ${blockers.map((b) => b.code).join(", ")}`);
  const handle = slug(blueprint.product.name);
  const visible = blueprint.sections.filter((section) => section.visible);
  const files: ShopifyThemeFile[] = visible.map((section) => ({ path: `sections/casamable-${handle}-${slug(section.id)}.liquid`, content: liquidFor(section) }));
  const templateSections: Record<string, unknown> = {};
  const order: string[] = [];
  for (const section of visible) {
    const key = slug(section.id).replace(/-/g, "_");
    order.push(key);
    templateSections[key] = {
      type: `casamable-${handle}-${slug(section.id)}`,
      settings: { eyebrow: section.eyebrow, heading: section.title, body: `<p>${section.body.replace(/[<>]/g, "")}</p>` },
      blocks: Object.fromEntries(section.items.map((item, index) => [`item_${index + 1}`, { type: "item", settings: { text: item } }])),
      block_order: section.items.map((_, index) => `item_${index + 1}`),
    };
  }
  const templatePath = `templates/product.casamable-${handle}.json`;
  files.push({ path: templatePath, content: JSON.stringify({ sections: templateSections, order }, null, 2) });
  files.push({ path: "assets/casamable-landing.css", content: SHARED_CSS });
  files.push({ path: "assets/casamable-landing.js", content: SHARED_JS });
  files.push({ path: "locales/es.casamable-landing.json", content: JSON.stringify({ casamable_landing: { cta: blueprint.brief.primaryCta, unavailable: "No disponible" } }, null, 2) });
  const manifest = {
    schemaVersion: 1 as const,
    blueprintId: blueprint.id,
    candidateId: blueprint.candidateId,
    generatedAt: now,
    published: false as const,
    entryTemplate: templatePath,
    files: [] as string[],
  };
  manifest.files = [...files.map((file) => file.path), "manifest.json"];
  files.push({ path: "manifest.json", content: JSON.stringify(manifest, null, 2) });
  return { name: `casamable-${handle}.zip`, files, manifest };
}

export function validateShopifyThemeBundle(bundle: ShopifyThemeBundle): string[] {
  const issues: string[] = [];
  const paths = new Set(bundle.files.map((file) => file.path));
  for (const required of [bundle.manifest.entryTemplate, "assets/casamable-landing.css", "assets/casamable-landing.js", "locales/es.casamable-landing.json", "manifest.json"]) {
    if (!paths.has(required)) issues.push(`Falta ${required}`);
  }
  for (const file of bundle.files) {
    if (/!important/i.test(file.content)) issues.push(`${file.path} usa !important`);
    if (file.path.endsWith(".json")) {
      try { JSON.parse(file.content); } catch { issues.push(`${file.path} no es JSON válido`); }
    }
    if (file.path.endsWith(".liquid")) {
      if (!file.content.includes("{% schema %}") || !file.content.includes("{% endschema %}")) issues.push(`${file.path} no contiene schema`);
      const match = file.content.match(/{% schema %}\n([\s\S]*?)\n{% endschema %}/);
      if (!match) issues.push(`${file.path} no permite extraer el schema`);
      else {
        try { JSON.parse(match[1]); } catch { issues.push(`${file.path} contiene schema JSON inválido`); }
      }
    }
  }
  return issues;
}

// ZIP "store" (sin compresión), suficiente para un bundle pequeño y evita
// incorporar una dependencia o un servicio externo. Shopify acepta ZIPs
// estándar con entradas UTF-8.
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): number[] { return [n & 255, (n >>> 8) & 255]; }
function u32(n: number): number[] { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }

export function bundleToZip(bundle: ShopifyThemeBundle): Uint8Array {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  let offset = 0;
  for (const file of bundle.files) {
    const name = enc.encode(file.path);
    const data = enc.encode(file.content);
    const crc = crc32(data);
    const localHeader = [0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...name];
    local.push(...localHeader, ...data);
    central.push(0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
    offset += localHeader.length + data.length;
  }
  const centralOffset = local.length;
  const end = [0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(bundle.files.length), ...u16(bundle.files.length), ...u32(central.length), ...u32(centralOffset), ...u16(0)];
  return new Uint8Array([...local, ...central, ...end]);
}
