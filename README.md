# NexoNIT

> "Sube el mazo de facturas. El grafo hace el resto."

Lector contable multi-documento. Arrastras un lote de facturas (PDF/JPG/PNG),
cada una se procesa individualmente contra GLM (Zhipu AI), se extraen sus
datos fiscales y se clasifica el rubro del emisor. El resultado alimenta una
matriz descargable en CSV y un grafo de nodos coloreados por industria.

## 1. Instalación local

```bash
npm install
```

## 2. Variable de entorno

Copia `.env.example` a `.env.local` y coloca tu clave de Zhipu AI:

```bash
cp .env.example .env.local
```

```
GLM_API_KEY=tu_api_key_de_zhipu_ai_aqui
```

En producción, esta variable se configura en **Vercel → Project Settings →
Environment Variables**. Nunca viaja al cliente: solo la lee
`api/process-batch-item.js` en el servidor.

## 3. Correr en desarrollo

Necesitas dos procesos: el frontend (Vite) y las funciones serverless
(Vercel CLI), porque `vite dev` por sí solo no ejecuta `/api`.

```bash
npm install -g vercel   # si no lo tienes
vercel dev              # sirve frontend + /api en localhost:3000
```

O, si prefieres solo frontend con datos de prueba (sin backend ni API key),
importa `src/mockBatch.json` en lugar de llamar al endpoint — útil para
validar la coloración del grafo de inmediato (ver sección 5).

## 4. Despliegue en Vercel

```bash
vercel --prod
```

Vercel detecta automáticamente:
- El frontend estático (Vite build → `dist/`).
- La función serverless en `api/process-batch-item.js` (runtime Node, sin
  configuración adicional gracias a `vercel.json`).

No se requiere configurar builds manualmente: `npm run build` genera `dist/`
y Vercel sirve `api/*.js` como funciones automáticamente.

## 5. Probar el grafo sin backend (datos de prueba)

`src/mockBatch.json` trae 10 facturas ya "procesadas" repartidas en 4
industrias (Ferretería, Alimentos/Bebidas, Tecnología, Servicios
Profesionales) y un receptor común, para que el grafo se vea poblado y
conectado desde el primer render. Para usarlo como atajo de desarrollo:

```jsx
import mockBatch from './mockBatch.json';
// Transforma cada entrada de mockBatch en un item de `queue` con status: 'done'
// y result: <la entrada completa>, y pásalo a setQueue([...]) al montar App.
```

No se integró por defecto en `App.jsx` para no mezclar datos ficticios con
el flujo real de producción; queda como semilla de prueba intencional.

## 6. Esquema de base de datos (Supabase)

El SQL de la tabla `batch_invoices` está en `supabase/schema.sql`. Inclúyelo
desde el SQL Editor de tu proyecto de Supabase, o vía CLI:

```bash
supabase db push
```

## 7. Estructura del proyecto

```
nexonit/
├── api/
│   └── process-batch-item.js   # Serverless: 1 archivo -> GLM -> JSON normalizado
├── src/
│   ├── App.jsx                 # Cola de subida, matriz y grafo
│   ├── main.jsx
│   ├── index.css
│   └── mockBatch.json          # 10 facturas de prueba, 4 industrias
├── supabase/
│   └── schema.sql              # Tabla batch_invoices + RLS
├── public/
│   └── manifest.json           # PWA manifest
├── index.html                  # Metadatos, Open Graph, favicon
├── vercel.json
├── vite.config.js
└── package.json
```

## Límites conocidos del MVP

- El límite de 50 documentos por sesión se aplica en el cliente (`App.jsx`);
  no hay aún un límite duro del lado del servidor.
- La cola procesa los archivos de forma secuencial (un `fetch` a la vez) para
  mantener la entropía baja y evitar saturar la función serverless. Si se
  necesita paralelismo controlado, se puede ajustar `processQueue` para
  correr N promesas concurrentes con un semáforo simple.
- `glm-4v` se usa para todo archivo de tipo imagen; un PDF nativo (no
  escaneado) puede requerir conversión previa a imagen si el modelo no lo
  acepta directamente — validar contra la documentación vigente de Zhipu AI.
