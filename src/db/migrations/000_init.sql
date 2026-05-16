-- Inicializa WAL mode (persistente en el header de la DB).
-- Se ejecuta ANTES que cualquier otra migracion.
-- Requiere que no haya conexiones competing (el migration runner es la unica conexion).

PRAGMA journal_mode = WAL;
