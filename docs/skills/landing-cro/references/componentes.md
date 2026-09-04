# Componentes — patrones de código probados

Copiar y adaptar (colores/nombres a los tokens de la DNA extraída). Todo vanilla, sin dependencias.

## Base de tokens

```css
:root{
  /* Color: sustituir por la DNA de la referencia — SIEMPRE en hex (Shopify color_picker) */
  --color-paper: #F7F5EE;
  --color-ink: #2A211C;
  --color-ink-soft: #5C5148;
  --color-accent: #7A2E2E;
  --color-accent-deep: #632424;
  --color-line: #E3DCCF;
  --color-focus: #2E6FD9;

  --font-display: "FuenteDeMarca", "AlternativaGratis", Georgia, serif;
  --font-body: "Inter", system-ui, sans-serif;

  /* Todo en px, nunca rem (Dawn redefine el tamaño raíz). Base = MÓVIL */
  --space-xs:8px; --space-sm:12px; --space-md:16px;
  --space-lg:24px; --space-xl:40px; --space-2xl:56px;
  --space-page:24px;                 /* gutter lateral móvil */

  /* Tipografía: pares móvil (aquí) / escritorio (en el media query 750px) */
  --font-size-base:15px; --font-size-h1:38px; --font-size-h2:28px;
  --font-size-lead:16px; --font-size-btn:14px; --font-size-price:28px;

  --ease-out: cubic-bezier(.22,.8,.35,1);
  --dur-fast:150ms; --dur-med:280ms;
  --radius-pill:999px;
}
html,body{ overflow-x:clip; }
html{ scroll-behavior:smooth; scroll-padding-top:84px; }
body{ font-size:var(--font-size-base); }
.wrap{ max-width:1280px; margin-inline:auto; padding-inline:var(--space-page); }
/* Breakpoints de Dawn y SOLO estos: base móvil, 750px y 990px */
@media (min-width:750px){ :root{
  --space-page:20px; --space-xl:52px; --space-2xl:80px;
  --font-size-base:16px; --font-size-h1:64px; --font-size-h2:42px;
  --font-size-lead:18px; --font-size-btn:16px; --font-size-price:36px;
} }
```

## Botón con press físico + ripple

```css
.btn{
  position:relative; overflow:hidden; white-space:nowrap;
  display:inline-flex; align-items:center; justify-content:center;
  padding:.95em 1.9em; border-radius:var(--radius-pill);
  background:var(--color-accent); color:var(--color-paper);
  border:2px solid var(--color-accent); font-weight:600; cursor:pointer;
  -webkit-tap-highlight-color:transparent;
  transition:background var(--dur-fast) var(--ease-out),
             transform var(--dur-fast) var(--ease-out),
             box-shadow var(--dur-fast) var(--ease-out);
}
.btn:hover{ background:var(--color-accent-deep); box-shadow:0 6px 18px oklch(0% 0 0/.08); }
.btn:active{ transform:translateY(2px) scale(.965); box-shadow:none; }
.btn:focus-visible{ outline:3px solid var(--color-focus); outline-offset:3px; }
.ripple{
  position:absolute; border-radius:50%; background:oklch(100% 0 0/.35);
  transform:scale(0); animation:ripple 520ms var(--ease-out) forwards; pointer-events:none;
}
@keyframes ripple{ to{ transform:scale(1); opacity:0; } }
```

```js
var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.querySelectorAll('.btn').forEach(function(btn){
  btn.addEventListener('pointerdown', function(e){
    if (reduced) return;
    var r = btn.getBoundingClientRect(), size = Math.max(r.width, r.height) * 2.2;
    var el = document.createElement('span'); el.className = 'ripple';
    el.style.width = el.style.height = size + 'px';
    el.style.left = (e.clientX - r.left - size/2) + 'px';
    el.style.top  = (e.clientY - r.top  - size/2) + 'px';
    btn.appendChild(el);
    el.addEventListener('animationend', function(){ el.remove(); });
  });
});
```

## Sticky add-to-cart móvil (aparece al hacer scroll)

```css
.buybar{
  position:fixed; inset-inline:0; bottom:0; z-index:60;
  display:none; align-items:center; justify-content:space-between; gap:var(--space-sm);
  padding:var(--space-sm) var(--space-md);
  padding-bottom:calc(var(--space-sm) + env(safe-area-inset-bottom));
  background:var(--color-paper); border-top:1px solid var(--color-line);
  box-shadow:0 -6px 24px oklch(0% 0 0/.08);
  transform:translateY(110%); visibility:hidden;
  transition:transform var(--dur-med) var(--ease-out), visibility 0s var(--dur-med);
}
.buybar.show{ transform:translateY(0); visibility:visible;
  transition:transform var(--dur-med) var(--ease-out); }
@media (max-width:749px){ .buybar{ display:flex; } body{ padding-bottom:72px; } }
```

```js
(function(){
  var bar = document.getElementById('buybar');
  if (!bar) return;
  var umbral = 1.2 * window.innerHeight, visible = false;
  addEventListener('resize', function(){ umbral = 1.2 * window.innerHeight; });
  addEventListener('scroll', function(){
    var pasa = scrollY > umbral;
    if (pasa !== visible){ visible = pasa; bar.classList.toggle('show', pasa); }
  }, { passive: true });
})();
/* Umbral de scroll, NO IntersectionObserver sobre el hero: al convertirse en
   sección independiente de Shopify no podrá observar otra sección */
```

## Carrusel full-bleed con snap y barra propia

```css
.track{
  position:relative; display:grid; grid-auto-flow:column;
  grid-auto-columns:min(280px, 78vw); gap:var(--space-md);
  overflow-x:auto; scroll-snap-type:x mandatory; padding-bottom:var(--space-sm);
  /* full-bleed: ocupa el viewport, la primera tarjeta alinea con el contenido */
  margin-inline:calc(50% - 50vw); padding-inline:calc(50vw - 50%);
  scroll-padding-inline:calc(50vw - 50%); scrollbar-width:none;
}
.track::-webkit-scrollbar{ display:none; }
.track > *{ scroll-snap-align:start; }
.track:focus-visible{ outline:3px solid var(--color-focus); outline-offset:4px; }

.scrollbar{
  position:relative; height:4px; max-width:420px; margin:var(--space-lg) auto 0;
  border-radius:var(--radius-pill); background:oklch(100% 0 0/.14);
  cursor:pointer; touch-action:none;
}
.thumb{
  position:absolute; top:-3px; left:0; height:10px; width:20%;
  border-radius:var(--radius-pill); background:var(--color-accent);
  transition:height var(--dur-fast) var(--ease-out), top var(--dur-fast) var(--ease-out);
}
.scrollbar:hover .thumb, .scrollbar.dragging .thumb{ height:14px; top:-5px; }
.scrollbar.dragging .thumb{ transition:none; }
```

```js
var track = document.querySelector('.track'),
    sbar = document.getElementById('scrollbar'),
    thumb = document.getElementById('thumb');
if (track && sbar && thumb) {
  var sync = function(){
    var max = track.scrollWidth - track.clientWidth;
    var w = Math.max(track.clientWidth / track.scrollWidth * 100, 10);
    thumb.style.width = w + '%';
    thumb.style.left = ((max ? track.scrollLeft / max : 0) * (100 - w)) + '%';
  };
  var seek = function(x){
    var r = sbar.getBoundingClientRect();
    var f = Math.min(1, Math.max(0, (x - r.left) / r.width));
    track.scrollLeft = f * (track.scrollWidth - track.clientWidth);
  };
  sbar.addEventListener('pointerdown', function(e){
    sbar.classList.add('dragging'); sbar.setPointerCapture(e.pointerId); seek(e.clientX);
  });
  sbar.addEventListener('pointermove', function(e){
    if (sbar.classList.contains('dragging')) seek(e.clientX);
  });
  ['pointerup','pointercancel'].forEach(function(ev){
    sbar.addEventListener(ev, function(){ sbar.classList.remove('dragging'); });
  });
  track.addEventListener('scroll', function(){ requestAnimationFrame(sync); }, { passive:true });
  addEventListener('resize', function(){ requestAnimationFrame(sync); });
  sync();
}
```

El track lleva `tabindex="0"` y `aria-label`; la barra es decorativa (`aria-hidden="true"`).

## Placeholders de medios

```css
.ph{
  display:flex; align-items:center; justify-content:center; text-align:center;
  border:2px dashed var(--color-line); border-radius:16px;
  background:var(--color-paper); color:var(--color-ink-soft);
  font-weight:500; padding:var(--space-md);
}
.ph--dark{ border-color:oklch(96% 0.015 80/.45); background:oklch(38% 0.11 18); color:oklch(96% 0.015 80/.8); }
.ph--hero{ aspect-ratio:16/9; } @media (min-width:990px){ .ph--hero{ aspect-ratio:4/5; } }
.ph--sq{ aspect-ratio:1/1; }
```

```html
<!-- Foto principal del producto (bolsa + vaso preparado). Sustituir por
     <img src="producto.jpg" alt="..." style="width:100%;height:auto;object-fit:cover;border-radius:16px;"> -->
<div class="ph ph--hero"></div>

<!-- Vídeo de fondo en bucle (descripción del plano aquí). VÍDEO REAL: elimina el placeholder y descomenta:
<video class="video-bg" autoplay muted loop playsinline poster="poster.jpg">
  <source src="fondo.mp4" type="video/mp4">
</video> -->
<div class="ph ph--dark"></div>
```

## Precio con oferta

```html
<div class="price-block">
  <span class="price">89&nbsp;€</span>
  <span class="price-old" aria-label="Precio anterior 105 euros">105&nbsp;€</span>
  <span class="save">Ahorra 16&nbsp;€</span>
  <span class="price-note">30 días · sale a 2,97&nbsp;€/día · Pago único</span>
</div>
```

```css
.price{ font-family:var(--font-display); font-size:var(--font-size-price); font-weight:700; }
.price-old{ font-family:var(--font-display); font-size:calc(var(--font-size-price)*.59); color:var(--color-ink-soft);
  text-decoration:line-through; text-decoration-thickness:2px; }
.save{ font-size:12px; font-weight:700; background:var(--color-accent);
  color:var(--color-paper); padding:.3em .85em; border-radius:var(--radius-pill); }
```

## FAQ nativa

```html
<details>
  <summary>¿Es una suscripción?</summary>
  <p>No. Pago único de 89 €. Sin renovaciones automáticas.</p>
</details>
```

```css
.faq details{ border-bottom:1px solid var(--color-line); }
.faq summary{ list-style:none; cursor:pointer; font-weight:600; min-height:44px;
  display:flex; justify-content:space-between; align-items:center; padding-block:var(--space-md); }
.faq summary::-webkit-details-marker{ display:none; }
.faq summary::after{ content:"+"; color:var(--color-accent); font-size:21px; }
.faq details[open] summary::after{ content:"–"; }
.faq summary:focus-visible{ outline:3px solid var(--color-focus); outline-offset:3px; }
```

## Iconos SVG reutilizables

```html
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.6-3 8.1-7 10-4-1.9-7-5.4-7-10V6z"/><path d="M9 12l2 2 4-4.5"/></symbol>
  <symbol id="i-truck" viewBox="0 0 24 24"><path d="M2.5 6.5h12v10h-12zM14.5 10h4l2.5 3v3.5h-6.5"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/></symbol>
  <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></symbol>
</defs></svg>
<svg class="ico" aria-hidden="true"><use href="#i-shield"/></svg>
```

```css
.ico{ width:24px; height:24px; stroke:currentColor; fill:none;
  stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
```

## Reduced motion global

```css
@media (prefers-reduced-motion: reduce){
  *{ transition-duration:1ms !important; animation-duration:1ms !important; }
  html{ scroll-behavior:auto; }
}
```
