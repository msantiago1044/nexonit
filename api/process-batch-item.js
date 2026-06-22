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

const client = new OpenAI({
  apiKey: process.env.GLM_API_KEY,
  baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
});

const SYSTEM_PROMPT = `Eres un auditor contable experto en taxonomía empresarial. Lee la factura adjunta. Extrae los datos obligatorios y deduce, basándote en los productos o servicios descritos, a qué categoría económica pertenece el emisor.

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

// Categorías canónicas para normalizar pequeñas variaciones de redacción del modelo
const CANONICAL_CATEGORIES = [
  'Ferretería y Construcción',
  'Alimentos / Bebidas',
  'Tecnología / Software',
  'Servicios Profesionales',
];

function normalizeCategory(raw) {
  if (!raw) return 'Otros';
  const match = CANONICAL_CATEGORIES.find(
    (c) => c.toLowerCase() === String(raw).toLowerCase()
  );
  return match || raw; // si no coincide exactamente, se deja tal cual y el front la pinta como "Otros"
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { filename, mimeType, fileBase64 } = req.body || {};

  if (!fileBase64 || !mimeType) {
    return res.status(400).json({ error: 'Falta el archivo o su tipo MIME' });
  }

  try {
    const isImage = mimeType.startsWith('image/');
    // glm-4v para imágenes/PDF visual, glm-4-flash como fallback rápido para
    // flujos de solo-texto si en el futuro se añade OCR previo.
    const model = isImage ? 'glm-4v' : 'glm-4-flash';

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
    });

    const rawContent = completion.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      // GLM puede envolver el JSON en bloques ```json a pesar de la instrucción;
      // se limpia por seguridad antes de parsear.
      const cleaned = rawContent.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(200).json({ error: 'Respuesta no parseable del modelo' });
    }

    if (parsed.error) {
      return res.status(200).json({ error: parsed.error });
    }

    if (parsed.emisor) {
      parsed.emisor.categoria_actividad = normalizeCategory(parsed.emisor.categoria_actividad);
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Error procesando factura con GLM:', err);
    return res.status(500).json({ error: 'Error al contactar el motor de extracción' });
  }
}
