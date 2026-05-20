-- Migration 008: añadir flows.parent_flow_id para trazabilidad prepare → execute.
-- ADR-007: cuando `flow confirm <prepareId>` crea un flow ejecutor, registra
-- la referencia al prepare original.
--
-- NULLABLE: los flows pre-existentes y los lanzados directamente con `coordinate`
-- (sin pasar por prepare/confirm) tienen parent_flow_id = NULL.
--
-- ON DELETE SET NULL: si se borra el prepare flow, el execute flow no se borra
-- en cascada (auditoría preservada), solo pierde la referencia.

ALTER TABLE flows
  ADD COLUMN parent_flow_id TEXT
    REFERENCES flows(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS flows_parent_idx ON flows(parent_flow_id)
  WHERE parent_flow_id IS NOT NULL;
