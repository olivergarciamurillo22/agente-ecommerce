# Landing Studio — uso rápido

Desde **Cazador de productos**, abre un candidato guardado y pulsa **Generar
landing**. El proyecto se abre en Landing Studio con el producto y el anuncio
de origen vinculados. Completa primero los datos económicos y las evidencias:
si falta un dato, se mostrará como ausente y la exportación puede quedar
bloqueada; el sistema no lo sustituye por una cifra inventada.

Para generar artefactos desde terminal:

```text
npm run landing:build -- --candidate 12
npm run landing:sections -- --html outputs/landings/candidato-12.html
npm run landing:lint -- --dir outputs/candidato-12-secciones
```

El primer comando crea un HTML autocontenido, el segundo lo separa en archivos
Liquid y el tercero revisa las reglas automáticas. Los archivos quedan en
`outputs/`; ningún comando escribe ni publica nada en Shopify.

Los proyectos editables se guardan solo en este navegador. Usa **Guardar
versión** antes de cambios grandes y **Exportar** cuando no queden bloqueos. El
ZIP descargado sigue marcado como no publicado.
