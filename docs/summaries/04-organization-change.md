# Resumen: Cambios Organizacionales

## Cambios en roles

### Sin cambios
- **Camila (PM)**: sigue definiendo que y por que. Ahora escribe historias para que las consuma una fabrica autonoma.
- **Lucas (UX)**: sigue diseniando, pero su salida es ahora un paquete tipado (tokens + components + a11y specs).
- **Roman (Tech Lead)**: sigue siendo el arbitro tecnico. Suma rol de **owner del orquestador**.
- **Valeria (Frontend)** y **Mateo (Backend)**: implementan. Ahora ademas son los primeros consumidores del orquestador.
- **Sofia (QA)**: sigue validando, pero ahora actua tambien como **auditora del sistema autonomo** (no solo del codigo).
- **Dante (DevOps)**: sigue gestionando deploys, pero ahora opera tambien el runtime del orquestador.

### Nuevo rol implicito
- **Angel (Operador)**: pasa de operador puntual a **product owner de la fabrica** y aprobador de gates criticos.

## Nuevas responsabilidades cruzadas

| Quien | Suma | Razon |
|---|---|---|
| Camila | Definicion de criterios de aceptacion automatizables | Los gates necesitan acceptance criteria parseables |
| Roman | Owner tecnico del orquestador mismo | Es el sistema mas critico del equipo |
| Sofia | Auditor del sistema autonomo | Vigilar que la autonomia no degrade calidad |
| Dante | Operador del runtime + observabilidad del orquestador | El orquestador es infra critica |
| Lucas | Diseniador del contrato inter-agentes | El "lenguaje" entre agentes es UX |
| Valeria | Owner del dashboard del operador | El humano necesita una UI clara |
| Mateo | Owner del modelo de datos y API del orquestador | Es backend puro |

## Cadencia de trabajo nueva

- **Daily standup**: ahora lo genera el orquestador automaticamente con metricas reales.
- **Sprint planning**: humano sigue priorizando; el orquestador estima en base a historia.
- **Retro mensual**: pasa a quincenal mientras la fabrica madura. Los datos los pone el sistema.
- **Design review**: solo cuando hay feature nueva (Lucas + Valeria + Roman). Ya no es por defecto.
- **Architecture review**: gate obligatorio en cada cambio arquitectonico. Sincronico, max 30 min.

## Politicas organizacionales

1. **No hay trabajo sin ticket** (regla universal).
2. **No hay merge sin firma de Sofia** (gate de calidad).
3. **No hay deploy a prod sin gate humano** (politica de riesgo).
4. **No hay overrun de budget sin re-aprobacion** (politica de costo).
5. **Toda decision arquitectonica vive en un ADR** (politica de trazabilidad).
6. **El kill-switch es de Angel** (politica de control).

## Onboarding de nuevos agentes

Para sumar un nuevo agente (ej. `softwarefactory_security`) basta con:

1. Crear su archivo de definicion en `agents/`.
2. Registrar su rol en `agents/index.md`.
3. Registrar su tarjeta de capacidades en el orquestador (que tipos de task acepta).
4. Definir su contrato de output (schema del ticket que produce).
5. Anotar en `organization_workflow.md` sus handoffs.

## Riesgo organizacional principal

Que la fabrica autonoma genere distancia entre el operador y el codigo. Mitigacion: auditoria semanal obligatoria + retro mensual con humanos leyendo artefactos reales.
