// /api/process-batch-item.js
//
// Función Serverless de Vercel. Recibe UN solo archivo por invocación
// (el frontend itera el lote y llama este endpoint una vez por archivo,
// ver src/App.jsx -> processQueue). Esto evita timeouts y picos de memoria
// al no cargar el lote completo en una sola ejecución.
//
// GLM (Zhipu AI) es compatible con el SDK estándar de OpenAI: solo se cambia
// el baseURL y la apiKey. La clave vive únicamente en las variables de
// entorno de Vercel (GLM_API_KEY) y nunca se expone al cliente.

import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

// Endpoint del portal chino (confirmado por los logs de error: la respuesta
// viene en chino simplificado con header server: ZenZGA, propio de
// open.bigmodel.cn). Si en el futuro migras a una cuenta del portal
// internacional Z.ai, este host cambiaría a https://api.z.ai/api/paas/v4/
// y los nombres de modelo también podrían diferir.
const client = new OpenAI({
  apiKey: process.env.GLM_API_KEY,
  baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
});

// Cliente de Supabase con la service_role key: vive solo en el servidor y
// puede insertar sin pasar por las políticas de RLS (que exigen un usuario
// autenticado). NUNCA exponer SUPABASE_SERVICE_KEY al frontend.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SYSTEM_PROMPT = `Eres un auditor contable experto en taxonomía empresarial. Lee la factura adjunta. Extrae los datos obligatorios y deduce, basándote en los productos o servicios descritos, a qué categoría económica pertenece el EMISOR (el proveedor que vende, no quien recibe la factura).

Para categoria_actividad debes elegir EXACTAMENTE una de estas 5 opciones, copiando el texto tal cual aparece aquí (sin traducir, sin agregar palabras, sin cambiar mayúsculas/minúsculas):
- "Ferretería y Construcción" — materiales de construcción, herramientas, ferreterías, insumos eléctricos/plomería.
- "Alimentos / Bebidas" — restaurantes, distribuidores de alimentos, bebidas, lácteos, panaderías, mercados.
- "Tecnología / Software" — licencias de software, hosting, equipos de cómputo, soporte técnico, telecomunicaciones.
- "Servicios Profesionales" — consultoría, contabilidad, abogados, auditoría, asesorías de cualquier tipo.
- "Otros" — únicamente si la factura no calza claramente en ninguna de las 4 anteriores.

No inventes una categoría nueva ni uses sinónimos distintos a estos 5 textos exactos.

Tu respuesta DEBE ser ÚNICAMENTE un JSON válido con esta estructura exacta:
{
  "emisor": {
    "nit": "900.123.456-7",
    "razon_social": "Distribuidores del Atlántico S.A.S",
    "categoria_actividad": "Ferretería y Construcción",
    "productos_ejemplo_detectados": ["Tornillo goloso 1/2", "Cemento blanco"]
  },
  "receptor": {
    "nit": "800.987.654-3",
    "razon_social": "Restaurante El Buen Sabor"
  },
  "factura_meta": {
    "fecha": "YYYY-MM-DD",
    "total_pagado": 154000.00
  }
}

Si el documento es ilegible, devuelve {"error": "Documento no válido"}`;

// Categorías canónicas: deben coincidir exactamente con las 5 opciones que
// el SYSTEM_PROMPT le exige al modelo. normalizeCategory() abajo es una red
// de seguridad para variantes de redacción que el modelo pueda colar a
// pesar de la instrucción (singular/plural, sin tilde, con "y"/"/", etc.).
const CANONICAL_CATEGORIES = [
  'Ferretería y Construcción',
  'Alimentos / Bebidas',
  'Tecnología / Software',
  'Servicios Profesionales',
];

// Variantes conocidas -> categoría canónica. Cubre los casos más comunes en
// que el modelo se desvía levemente del texto exacto pedido.
const CATEGORY_ALIASES = {
  'ferreteria y construccion': 'Ferretería y Construcción',
  'ferreteria / construccion': 'Ferretería y Construcción',
  'ferreteria': 'Ferretería y Construcción',
  'construccion': 'Ferretería y Construcción',
  'alimentos y bebidas': 'Alimentos / Bebidas',
  'alimentos / bebidas': 'Alimentos / Bebidas',
  'alimentos': 'Alimentos / Bebidas',
  'bebidas': 'Alimentos / Bebidas',
  'restaurante': 'Alimentos / Bebidas',
  'tecnologia y software': 'Tecnología / Software',
  'tecnologia / software': 'Tecnología / Software',
  'tecnologia': 'Tecnología / Software',
  'software': 'Tecnología / Software',
  'servicios profesionales': 'Servicios Profesionales',
  'consultoria': 'Servicios Profesionales',
  'servicios': 'Servicios Profesionales',
};

// Quita tildes y pasa a minúsculas, para comparar sin que un acento
// faltante o de más rompa el match (ej. "Tecnologia" vs "Tecnología").
function stripAccents(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normalizeCategory(raw) {
  if (!raw) return 'Otros';
  const cleaned = stripAccents(String(raw));

  // 1. Match exacto contra las categorías canónicas (ignorando tildes/caso)
  const exact = CANONICAL_CATEGORIES.find((c) => stripAccents(c) === cleaned);
  if (exact) return exact;

  // 2. Match contra alias conocidos
  if (CATEGORY_ALIASES[cleaned]) return CATEGORY_ALIASES[cleaned];

  // 3. Match parcial: si el texto del modelo contiene una palabra clave de
  // algún alias (ej. "Ferretería, Construcción y afines" -> contiene
  // "ferreteria")
  const partialMatch = Object.keys(CATEGORY_ALIASES).find((key) => cleaned.includes(key));
  if (partialMatch) return CATEGORY_ALIASES[partialMatch];

  // 4. Si el modelo dijo explícitamente "otros" o no reconocemos nada,
  // se deja tal cual y el frontend la pinta como "Otros" (slate).
  return raw;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { filename, mimeType, fileBase64, batchId } = req.body || {};

  if (!fileBase64 || !mimeType) {
    return res.status(400).json({ error: 'Falta el archivo o su tipo MIME' });
  }

  try {
    const isImage = mimeType.startsWith('image/');
    // glm-4.6v-flash es el modelo de visión vigente y gratuito en el portal
    // open.bigmodel.cn (confirmado en docs.bigmodel.cn). glm-4.7-flash cubre
    // flujos de solo-texto si en el futuro se añade OCR previo.
    // Los nombres de modelo de GLM cambian con cierta frecuencia: si vuelves
    // a ver errores 500/400 aquí (mensaje "模型不存在" = "el modelo no existe"),
    // confirma el catálogo actual en https://docs.bigmodel.cn/cn/guide/models
    // antes de asumir que es un problema de API key.
    const model = isImage ? 'glm-4.6v-flash' : 'glm-4.7-flash';

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${fileBase64}` },
            },
            {
              type: 'text',
              text: `Archivo: ${filename}. Extrae los datos según las instrucciones del sistema.`,
            },
          ],
        },
      ],
      temperature: 0.1,
      // Desactiva el modo "thinking" (razonamiento extendido) de los modelos
      // glm-4.6v-flash / glm-4.7-flash. Para esta tarea de extracción
      // estructurada no aporta calidad, pero sí añade varios segundos de
      // latencia — suficientes para disparar el timeout de la función
      // serverless. Si en el futuro necesitas más precisión a costa de
      // velocidad, puedes volver a poner { type: 'enabled' }.
      thinking: { type: 'disabled' },
    });

    const rawContent = completion.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      // GLM puede envolver el JSON en bloques ```json a pesar de la instrucción;
      // se limpia por seguridad antes de parsear.
      const cleaned = rawContent.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      await saveToSupabase({ batchId, filename, status: 'error', errorMessage: 'Respuesta no parseable del modelo' });
      return res.status(200).json({ error: 'Respuesta no parseable del modelo' });
    }

    if (parsed.error) {
      await saveToSupabase({ batchId, filename, status: 'error', errorMessage: parsed.error });
      return res.status(200).json({ error: parsed.error });
    }

    if (parsed.emisor) {
      parsed.emisor.categoria_actividad = normalizeCategory(parsed.emisor.categoria_actividad);
    }

    await saveToSupabase({ batchId, filename, status: 'done', data: parsed, modelo: model });

    return res.status(200).json(parsed);
  } catch (err) {
    // err.status / err.message suelen traer el motivo real (modelo inválido,
    // clave inválida, saldo insuficiente, etc.) — quedan en los logs de
    // Vercel (Project → Logs) para diagnóstico, nunca se exponen al cliente.
    console.error('Error procesando factura con GLM:', err.status, err.message, err);
    await saveToSupabase({ batchId, filename, status: 'error', errorMessage: 'Error al contactar el motor de extracción' });
    return res.status(500).json({ error: 'Error al contactar el motor de extracción' });
  }
}

// Inserta el resultado del procesamiento en batch_invoices. Si Supabase no
// está configurado (variables de entorno ausentes) o el insert falla, solo
// se loguea — nunca debe tumbar la respuesta al usuario, que ya tiene el
// resultado de GLM independientemente de si se guardó o no.
async function saveToSupabase({ batchId, filename, status, data, errorMessage, modelo }) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.warn('Supabase no configurado: se omite el guardado de', filename);
    return;
  }

  const row = {
    batch_id: batchId || null,
    filename,
    status,
    error_message: errorMessage || null,
    emisor_nit: data?.emisor?.nit || null,
    emisor_razon_social: data?.emisor?.razon_social || null,
    categoria_actividad: data?.emisor?.categoria_actividad || null,
    productos_ejemplo_detectados: data?.emisor?.productos_ejemplo_detectados || null,
    receptor_nit: data?.receptor?.nit || null,
    receptor_razon_social: data?.receptor?.razon_social || null,
    fecha_factura: data?.factura_meta?.fecha || null,
    total_pagado: data?.factura_meta?.total_pagado ?? null,
    modelo_glm: modelo || null,
  };

  const { error } = await supabase.from('batch_invoices').insert(row);
  if (error) {
    console.error('Error guardando en Supabase:', error.message);
  }
}
