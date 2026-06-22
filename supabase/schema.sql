-- =============================================================================
-- NexoNIT · Esquema de Supabase para el MVP de procesamiento por lotes
-- =============================================================================

create table if not exists public.batch_invoices (
  id                          uuid primary key default gen_random_uuid(),
  created_at                  timestamptz not null default now(),

  -- Identificación del lote y archivo de origen
  batch_id                    uuid not null,
  filename                    text not null,
  status                      text not null default 'pending'
                               check (status in ('pending', 'reading', 'done', 'error')),
  error_message                text,

  -- Datos del emisor (proveedor)
  emisor_nit                  text,
  emisor_razon_social         text,
  categoria_actividad         text,                 -- nueva columna: rubro deducido por GLM
  productos_ejemplo_detectados jsonb,                -- array de strings, ej: ["Tornillo goloso 1/2"]

  -- Datos del receptor (la empresa que sube la factura)
  receptor_nit                text,
  receptor_razon_social       text,

  -- Metadatos de la factura
  fecha_factura                date,
  total_pagado                 numeric(14, 2),

  -- Trazabilidad del modelo usado
  modelo_glm                   text default 'glm-4v'
);

comment on table public.batch_invoices is
  'Facturas procesadas por lote en NexoNIT. Cada fila es un documento individual del lote, clasificado por GLM (Zhipu AI).';

comment on column public.batch_invoices.categoria_actividad is
  'Rubro/sector económico del emisor, deducido por GLM a partir de los productos/servicios facturados. Alimenta el color del nodo en el Grafo Cromático.';

comment on column public.batch_invoices.productos_ejemplo_detectados is
  'Lista de productos o servicios detectados en la factura que el modelo usó para inferir categoria_actividad.';

-- Índices para las consultas más frecuentes del dashboard
create index if not exists idx_batch_invoices_batch_id on public.batch_invoices (batch_id);
create index if not exists idx_batch_invoices_categoria on public.batch_invoices (categoria_actividad);
create index if not exists idx_batch_invoices_emisor_nit on public.batch_invoices (emisor_nit);

-- Row Level Security: cada empresa (tenant) solo ve sus propias facturas.
-- Ajustar el nombre de la columna/tabla de tenant según el esquema de auth final.
alter table public.batch_invoices enable row level security;

create policy "Las empresas solo ven sus propias facturas"
  on public.batch_invoices
  for select
  using (auth.uid() is not null);

create policy "Las empresas solo insertan sus propias facturas"
  on public.batch_invoices
  for insert
  with check (auth.uid() is not null);
