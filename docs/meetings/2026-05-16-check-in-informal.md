# Reunion: Check-in informal del equipo
**Fecha:** 2026-05-16
**Equipo:** softwarefactory
**Convocada por:** Angel (angel.oliver@kunfupay.com)
**Tipo:** Round-table abierto, sin agenda predefinida
**Participantes:**
- Camila — Product Manager
- Roman — Tech Lead
- Valeria — Frontend Developer
- Mateo — Backend Developer
- Sofia — QA Engineer
- Dante — DevOps Engineer
- Lucas — UX Designer

## Contexto

Angel convoca al equipo con un mensaje abierto: *"gente linda. los que esten en team de softwarefactory podemos hablar un momento."* Se interpreta como un check-in informal donde cada miembro comparte estado actual y un tema que quisiera plantear.

## Discusion

### Camila (Product Manager)
Revisando el backlog de cobranza y validando con stakeholders qué features del roadmap Q2 siguen siendo prioridad frente a necesidades operativas que están surgiendo en producción.
**Plantea:** Deuda técnica acumulada en el módulo de PTPs. Roman ya la mencionó como impacto en velocidad. Necesita decidir si destinar un sprint completo a refactoring o abordarlo incremental, antes de comprometer nuevas fechas con el negocio.

### Roman (Tech Lead)
Estado técnico estable. Flujo entre Valeria y Mateo funcionando, deploys con Dante controlados, Sofia cubriendo casos críticos. Sin bloqueos graves.
**Plantea:** Falta consenso sobre estrategia de testing para CobraGest. Hay estructura de carpetas, pero no acuerdo sobre qué testear primero ni cómo distribuir esfuerzo entre unit / integration / e2e. Propone agendar 30 min esta semana.

### Valeria (Frontend Developer)
Revisando estructura de componentes para asegurar un design system sólido desde el inicio, con foco en accesibilidad y reutilización.
**Plantea:** Necesita cerrar contratos de API con Mateo antes de avanzar con componentes que consumen datos. Pide a Lucas una revisión de tokens de diseño (colores, espaciado, tipografía) para configurar Tailwind correctamente.

### Mateo (Backend Developer)
Revisando modelado de datos para módulo de cobranza y arquitectura de PTPs. Mapeando la transición de lógica entre FoxPro legacy y MongoDB.
**Plantea:** No está definida la estrategia de autenticación y permisos para los endpoints de cobranza. Bloquea contratos con Valeria. También quiere revisar con Dante los scripts de migración para consistencia de datos. Pide validación de Roman sobre el approach.

### Sofia (QA Engineer)
Cobertura decente en backend (APIs de cobranza), pero gaps importantes en tests de integración del frontend. Flujos E2E críticos siguen siendo mayormente manuales → riesgo en cada deploy.
**Plantea:** Definir un "Definition of Done" que incluya cobertura mínima y tipos de test requeridos. Priorizar automatización E2E en flujos de pagos y PTPs, que son los que más bugs generan en producción.

### Dante (DevOps Engineer)
Ambientes (dev, staging, prod) operativos, pipelines CI/CD sin incidentes recientes, monitoreo y logs activos.
**Plantea:** Migraciones de base de datos todavía se ejecutan manualmente por Mateo antes de cada deploy → punto de falla. Propone automatizar el flujo completo de migraciones dentro del pipeline esta semana, con visto bueno de Roman.

### Lucas (UX Designer)
Revisando el design system: hay componentes que necesitan actualización y tokens de color sin documentar bien. Mapeando flujos de usuario para la feature de PTPs mencionada por Camila.
**Plantea:** Coordinación entre diseño y frontend a mejorar. Aparecen inconsistencias visuales en producción que no coinciden con los specs entregados. Pide a Valeria una sesión corta de handoff cuando esté lista la próxima feature.

## Patrones detectados

Tres temas convergen sin haber sido coordinados previamente:

1. **PTPs como epicentro:** Camila lo prioriza desde negocio, Mateo lo está modelando, Lucas está mapeando flujos, Sofia lo marca como uno de los flujos más buggeados, Roman lo identificó como deuda técnica. → Es el tema crítico real del momento.
2. **Contratos y handoffs flojos:** Valeria↔Mateo (API contracts), Valeria↔Lucas (tokens y specs), Mateo↔Dante (migraciones). Los handoffs informales están generando bloqueos en cadena.
3. **Estrategia de calidad sin consenso:** Roman quiere definirla, Sofia quiere un DoD con cobertura mínima, Dante quiere automatizar migraciones en pipeline. Las tres piezas pertenecen a la misma conversación.

## Decisiones

1. Convocar una sesión técnica de 30 min esta semana, liderada por Roman, para definir estrategia de testing y Definition of Done. Participan: Roman, Sofia, Valeria, Mateo.
2. Camila y Roman acuerdan revisar el alcance de la deuda técnica de PTPs antes de cerrar fechas con negocio. Roman entrega evaluación de impacto vs. costo.
3. Mateo bloquea avance de contratos de API hasta que Roman valide modelo de autenticación y permisos para endpoints de cobranza. Prioridad alta.
4. Dante coordina con Roman y Mateo la automatización de migraciones en el pipeline; objetivo: eliminar el paso manual antes del próximo deploy a producción.
5. Lucas y Valeria establecen sesión de handoff fija por feature antes de comenzar implementación, con revisión de tokens de Tailwind como primer entregable conjunto.

## Action Items

| Responsable | Tarea | Fecha limite |
|---|---|---|
| Roman | Agendar sesión de estrategia de testing + DoD (con Sofia, Valeria, Mateo) | 2026-05-22 |
| Roman | Evaluación de impacto y costo del refactor de deuda técnica en PTPs | 2026-05-23 |
| Roman + Mateo | Definir modelo de autenticación y permisos para endpoints de cobranza | 2026-05-20 |
| Mateo + Valeria | Cerrar contratos de API para módulo de cobranza | 2026-05-25 |
| Lucas + Valeria | Sesión de handoff y revisión de tokens (colores, espaciado, tipografía) para Tailwind | 2026-05-19 |
| Dante + Mateo | Automatizar migraciones de BD en el pipeline CI/CD | 2026-05-27 |
| Camila | Confirmar prioridad Q2 vs operativas con stakeholders, esperar input de Roman sobre PTPs | 2026-05-23 |
| Sofia | Borrador de Definition of Done con cobertura mínima por tipo de test | 2026-05-22 |

## Proxima reunion sugerida

Sesión técnica de 30 min sobre estrategia de testing y DoD — Roman, Sofia, Valeria, Mateo — antes del 2026-05-22.
