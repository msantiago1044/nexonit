import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

// ---------------------------------------------------------------------------
// Paleta fija de categorías. Si GLM devuelve una categoría que no está en este
// mapa, se aplica "Otros" (slate) para no romper el grafo con colores random.
// ---------------------------------------------------------------------------
const CATEGORY_COLORS = {
  'Ferretería y Construcción': '#f97316',
  'Ferretería / Construcción': '#f97316',
  'Alimentos / Bebidas': '#22c55e',
  'Alimentos y Bebidas': '#22c55e',
  'Tecnología / Software': '#06b6d4',
  'Tecnología y Software': '#06b6d4',
  'Servicios Profesionales': '#a855f7',
};
const DEFAULT_COLOR = '#64748b'; // Otros

function colorForCategory(category) {
  return CATEGORY_COLORS[category] || DEFAULT_COLOR;
}

function legendEntries() {
  // Construye la leyenda a partir del mapa fijo, deduplicando por color
  const seen = new Map();
  Object.entries(CATEGORY_COLORS).forEach(([label, color]) => {
    if (!seen.has(color)) seen.set(color, label);
  });
  seen.set(DEFAULT_COLOR, 'Otros');
  return Array.from(seen.entries()).map(([color, label]) => ({ color, label }));
}

// ---------------------------------------------------------------------------
// Estados de un ítem en la cola visual
// ---------------------------------------------------------------------------
const STATUS = {
  PENDING: 'pending',
  READING: 'reading',
  DONE: 'done',
  ERROR: 'error',
};

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.readAsDataURL(file);
  });
}

function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value);
}

let nextId = 1;

export default function App() {
  const [queue, setQueue] = useState([]); // [{id, file, status, result, error}]
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef(null);
  const isProcessingRef = useRef(false);

  // -------------------------------------------------------------------------
  // Título dinámico de la pestaña según el estado global del lote
  // -------------------------------------------------------------------------
  useEffect(() => {
    const total = queue.length;
    const done = queue.filter((q) => q.status === STATUS.DONE || q.status === STATUS.ERROR).length;
    const inFlightIndex = queue.findIndex((q) => q.status === STATUS.READING);

    if (total === 0) {
      document.title = '📂 NexoNIT | Lector Contable Multi-Documento';
    } else if (inFlightIndex !== -1) {
      document.title = `⚡ Procesando factura [${inFlightIndex + 1} de ${total}]... | NexoNIT`;
    } else if (done === total) {
      const addedNodes = new Set(
        queue.filter((q) => q.status === STATUS.DONE).map((q) => q.result?.emisor?.categoria_actividad)
      ).size;
      document.title = `📊 ¡Lote completado! ${queue.filter((q) => q.status === STATUS.DONE).length} nodos añadidos | NexoNIT`;
    }
  }, [queue]);

  // -------------------------------------------------------------------------
  // Cola de cliente de baja entropía: NO se envía un array de archivos al
  // backend. Se itera localmente y se hace un fetch individual por archivo,
  // actualizando el estado de cada renglón en tiempo real. Esto evita
  // saturar la memoria/timeout de la función serverless en Vercel.
  // -------------------------------------------------------------------------
  const processQueue = useCallback(async (items) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    for (const item of items) {
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: STATUS.READING } : q)));

      try {
        const base64 = await fileToBase64(item.file);

        const response = await fetch('/api/process-batch-item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: item.file.name,
            mimeType: item.file.type,
            fileBase64: base64,
          }),
        });

        if (!response.ok) {
          throw new Error(`Error del servidor (${response.status})`);
        }

        const data = await response.json();

        if (data?.error) {
          setQueue((prev) =>
            prev.map((q) => (q.id === item.id ? { ...q, status: STATUS.ERROR, error: data.error } : q))
          );
        } else {
          setQueue((prev) =>
            prev.map((q) => (q.id === item.id ? { ...q, status: STATUS.DONE, result: data } : q))
          );
        }
      } catch (err) {
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id ? { ...q, status: STATUS.ERROR, error: err.message || 'Fallo de red' } : q
          )
        );
      }
    }

    isProcessingRef.current = false;
  }, []);

  const handleFiles = useCallback(
    (fileList) => {
      const files = Array.from(fileList).slice(0, 50); // límite de 50 por sesión
      if (files.length === 0) return;

      const newItems = files.map((file) => ({
        id: nextId++,
        file,
        status: STATUS.PENDING,
        result: null,
        error: null,
      }));

      setQueue((prev) => [...prev, ...newItems]);
      processQueue(newItems);
    },
    [processQueue]
  );

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const onInputChange = useCallback(
    (e) => {
      if (e.target.files?.length) handleFiles(e.target.files);
      e.target.value = '';
    },
    [handleFiles]
  );

  // -------------------------------------------------------------------------
  // Derivados: filas de la matriz + datos del grafo
  // -------------------------------------------------------------------------
  const completedRows = useMemo(() => queue.filter((q) => q.status === STATUS.DONE), [queue]);

  const graphData = useMemo(() => {
    const nodes = [];
    const links = [];
    const seenSuppliers = new Map();

    completedRows.forEach((row) => {
      const emisor = row.result?.emisor;
      const receptor = row.result?.receptor;
      if (!emisor?.nit) return;

      const category = emisor.categoria_actividad || 'Otros';
      const color = colorForCategory(category);

      if (!seenSuppliers.has(emisor.nit)) {
        seenSuppliers.set(emisor.nit, true);
        nodes.push({
          id: emisor.nit,
          name: emisor.razon_social || emisor.nit,
          category,
          color,
          val: 6,
        });
      }

      if (receptor?.nit) {
        if (!seenSuppliers.has(receptor.nit)) {
          seenSuppliers.set(receptor.nit, true);
          nodes.push({
            id: receptor.nit,
            name: receptor.razon_social || receptor.nit,
            category: 'Receptor',
            color: '#f5f4f0',
            val: 9,
          });
        }
        links.push({ source: emisor.nit, target: receptor.nit });
      }
    });

    return { nodes, links };
  }, [completedRows]);

  const handleDownloadCsv = useCallback(() => {
    const header = ['Estado', 'Fecha', 'NIT Emisor', 'Razón Social', 'Sector/Categoría', 'Total ($)'];
    const rows = completedRows.map((row) => {
      const r = row.result;
      return [
        'Extraída',
        r?.factura_meta?.fecha || '',
        r?.emisor?.nit || '',
        r?.emisor?.razon_social || '',
        r?.emisor?.categoria_actividad || '',
        r?.factura_meta?.total_pagado ?? '',
      ];
    });

    const csvContent = [header, ...rows]
      .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexonit_lote_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [completedRows]);

  const legend = useMemo(() => legendEntries(), []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-row">
          <h1 className="brand-name">
            Nexo<span className="dot">NIT</span>
          </h1>
          <span className="brand-slogan">"Sube el mazo de facturas. El grafo hace el resto."</span>
        </div>
        <p className="brand-sub">
          Procesamiento por lotes de facturas con extracción fiscal y clasificación automática de
          rubro vía GLM (Zhipu AI). Cada proveedor se convierte en un nodo de tu mapa de gasto.
        </p>
      </header>

      <main className="app-main">
        {/* ---------------- Tolva de carga ---------------- */}
        <section>
          <p className="section-label">01 · La Tolva de Carga</p>
          <div
            className={`dropzone${isDragging ? ' is-dragging' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
          >
            <span className="dropzone-icon">📂</span>
            <p className="dropzone-title">
              Arrastra tu carpeta de facturas del mes (PDF, JPG, PNG)
            </p>
            <p className="dropzone-hint">Aceptamos hasta 50 documentos por sesión.</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="application/pdf,image/png,image/jpeg"
              onChange={onInputChange}
            />
          </div>

          {queue.length > 0 && (
            <div className="inspection-row">
              {queue.map((item) => (
                <QueueRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </section>

        {/* ---------------- Matriz enriquecida ---------------- */}
        <section>
          <p className="section-label">02 · La Matriz Enriquecida</p>
          <div className="matrix-panel">
            <div className="matrix-toolbar">
              <h2>Resultados extraídos ({completedRows.length})</h2>
              <button className="btn-download" disabled={completedRows.length === 0} onClick={handleDownloadCsv}>
                ⬇ Descargar Lote en Excel (.CSV)
              </button>
            </div>
            <div className="matrix-table-wrap">
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th>Estado</th>
                    <th>Fecha</th>
                    <th>NIT Emisor</th>
                    <th>Razón Social</th>
                    <th>Sector/Categoría</th>
                    <th>Total ($)</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.length === 0 && (
                    <tr>
                      <td colSpan={6} className="empty-row">
                        Esperando el primer lote...
                      </td>
                    </tr>
                  )}
                  {queue.map((item) => (
                    <MatrixRow key={item.id} item={item} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ---------------- Grafo cromático ---------------- */}
        <section>
          <p className="section-label">03 · El Grafo Cromático</p>
          <div className="graph-panel">
            <div className="graph-panel-inner">
              {graphData.nodes.length === 0 ? (
                <div className="graph-empty-state">
                  El grafo se construye a medida que GLM clasifica cada factura.
                  <br />
                  Sube tu primer lote para ver los nodos aparecer.
                </div>
              ) : (
                <ForceGraph2D
                  graphData={graphData}
                  nodeLabel={(node) => `${node.name} — ${node.category}`}
                  nodeColor={(node) => node.color}
                  nodeVal={(node) => node.val}
                  linkColor={() => 'rgba(245, 244, 240, 0.25)'}
                  backgroundColor="transparent"
                  width={undefined}
                  height={460}
                />
              )}
              <div className="graph-legend">
                <p className="graph-legend-title">Simbología</p>
                {legend.map((entry) => (
                  <div className="legend-item" key={entry.color}>
                    <span className="legend-dot" style={{ background: entry.color }} />
                    {entry.label}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="app-footer">NexoNIT · Lector contable multi-documento · MVP</footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponentes
// ---------------------------------------------------------------------------
function QueueRow({ item }) {
  const category = item.result?.emisor?.categoria_actividad;

  let icon = '⏳';
  let statusText = 'En espera...';
  let rowClass = '';

  if (item.status === STATUS.READING) {
    icon = '⏳';
    statusText = 'Leyendo vectores...';
  } else if (item.status === STATUS.DONE) {
    icon = '✅';
    statusText = `Extraída (${category || 'Sin categoría'})`;
    rowClass = 'status-done';
  } else if (item.status === STATUS.ERROR) {
    icon = '⚠️';
    statusText = item.error || 'No se pudo procesar';
    rowClass = 'status-error';
  }

  return (
    <div className={`queue-item ${rowClass}`}>
      <span className={`icon${item.status === STATUS.READING ? ' spinning' : ''}`}>{icon}</span>
      <span className="filename">{item.file.name}</span>
      <span className="status-text">{statusText}</span>
    </div>
  );
}

function MatrixRow({ item }) {
  if (item.status === STATUS.PENDING || item.status === STATUS.READING) {
    return (
      <tr>
        <td>
          <span className="status-pill pending">⏳ Leyendo</span>
        </td>
        <td colSpan={5} style={{ color: 'var(--muted-dark)' }}>
          {item.file.name}
        </td>
      </tr>
    );
  }

  if (item.status === STATUS.ERROR) {
    return (
      <tr>
        <td>
          <span className="status-pill error">⚠ Error</span>
        </td>
        <td colSpan={5} style={{ color: '#b91c1c' }}>
          {item.file.name} — {item.error}
        </td>
      </tr>
    );
  }

  const r = item.result;
  const category = r?.emisor?.categoria_actividad || 'Otros';

  return (
    <tr>
      <td>
        <span className="status-pill ok">✅ Extraída</span>
      </td>
      <td>{r?.factura_meta?.fecha || '—'}</td>
      <td>{r?.emisor?.nit || '—'}</td>
      <td>{r?.emisor?.razon_social || '—'}</td>
      <td>
        <span className="category-chip">
          <span className="category-dot" style={{ background: colorForCategory(category) }} />
          {category}
        </span>
      </td>
      <td>{formatCurrency(r?.factura_meta?.total_pagado)}</td>
    </tr>
  );
}
