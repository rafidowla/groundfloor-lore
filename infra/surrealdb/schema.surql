-- ============================================================================
-- Groundfloor Lore — SurrealDB Schema
-- Run once after first start:
--   docker exec -i surrealdb /surreal sql \
--     --endpoint http://localhost:8000 --username root --password <PASS> \
--     < schema.surql
-- ============================================================================

-- ─── NAMESPACE: groundfloor (Lore + Code Intelligence) ──────────────────────

DEFINE NAMESPACE IF NOT EXISTS groundfloor;
USE NS groundfloor;

DEFINE DATABASE IF NOT EXISTS lore;
USE DB lore;

-- ─── KNOWLEDGE NODES ────────────────────────────────────────────────────────

DEFINE TABLE lore_node SCHEMAFULL;
DEFINE FIELD type       ON lore_node TYPE string;
DEFINE FIELD label      ON lore_node TYPE string;
DEFINE FIELD content    ON lore_node TYPE option<string>;
DEFINE FIELD tags       ON lore_node TYPE option<array<string>>;
DEFINE FIELD project    ON lore_node TYPE option<string>;
DEFINE FIELD ecosystem  ON lore_node TYPE option<string>;
DEFINE FIELD org_id     ON lore_node TYPE string;
DEFINE FIELD created_by ON lore_node TYPE option<string>;
DEFINE FIELD created_at ON lore_node TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON lore_node TYPE datetime DEFAULT time::now();
DEFINE FIELD sync_id    ON lore_node TYPE option<string>;
DEFINE INDEX idx_org    ON lore_node FIELDS org_id;
DEFINE INDEX idx_type   ON lore_node FIELDS type;

-- ─── KNOWLEDGE EDGES (Graph Relations) ──────────────────────────────────────

DEFINE TABLE relates_to  TYPE RELATION FROM lore_node TO lore_node SCHEMAFULL;
DEFINE TABLE depends_on  TYPE RELATION FROM lore_node TO lore_node SCHEMAFULL;
DEFINE TABLE applies_to  TYPE RELATION FROM lore_node TO lore_node SCHEMAFULL;
DEFINE TABLE fixed_by    TYPE RELATION FROM lore_node TO lore_node SCHEMAFULL;
DEFINE TABLE caused_by   TYPE RELATION FROM lore_node TO lore_node SCHEMAFULL;
DEFINE TABLE decided_for TYPE RELATION FROM lore_node TO lore_node SCHEMAFULL;
DEFINE TABLE supersedes  TYPE RELATION FROM lore_node TO lore_node SCHEMAFULL;

-- ─── CANONICAL CODE SYMBOLS ─────────────────────────────────────────────────

DEFINE TABLE code_symbol SCHEMAFULL;
DEFINE FIELD name       ON code_symbol TYPE string;
DEFINE FIELD kind       ON code_symbol TYPE string;
DEFINE FIELD file_path  ON code_symbol TYPE string;
DEFINE FIELD repo       ON code_symbol TYPE string;
DEFINE FIELD branch     ON code_symbol TYPE string DEFAULT 'main';
DEFINE FIELD org_id     ON code_symbol TYPE string;
DEFINE FIELD signature  ON code_symbol TYPE option<string>;
DEFINE FIELD return_type ON code_symbol TYPE option<string>;
DEFINE FIELD indexed_at ON code_symbol TYPE datetime DEFAULT time::now();
DEFINE INDEX idx_repo   ON code_symbol FIELDS repo, org_id;
DEFINE INDEX idx_name   ON code_symbol FIELDS name;

-- ─── CODE EDGES ─────────────────────────────────────────────────────────────

DEFINE TABLE calls       TYPE RELATION FROM code_symbol TO code_symbol SCHEMAFULL;
DEFINE FIELD confidence  ON calls TYPE option<float> DEFAULT 1.0;
DEFINE FIELD reason      ON calls TYPE option<string>;

DEFINE TABLE imports     TYPE RELATION FROM code_symbol TO code_symbol SCHEMAFULL;
DEFINE TABLE extends     TYPE RELATION FROM code_symbol TO code_symbol SCHEMAFULL;
DEFINE TABLE implements  TYPE RELATION FROM code_symbol TO code_symbol SCHEMAFULL;
DEFINE TABLE has_method  TYPE RELATION FROM code_symbol TO code_symbol SCHEMAFULL;
DEFINE TABLE has_property TYPE RELATION FROM code_symbol TO code_symbol SCHEMAFULL;

DEFINE TABLE accesses    TYPE RELATION FROM code_symbol TO code_symbol SCHEMAFULL;
DEFINE FIELD reason      ON accesses TYPE option<string>;

-- ─── CROSS-PILLAR EDGES (Knowledge ↔ Code) ──────────────────────────────────

DEFINE TABLE documents   TYPE RELATION FROM lore_node TO code_symbol SCHEMAFULL;
DEFINE FIELD relation    ON documents TYPE option<string>;

-- ─── DEVELOPER ACTIVITY ─────────────────────────────────────────────────────

DEFINE TABLE dev_activity SCHEMAFULL;
DEFINE FIELD developer       ON dev_activity TYPE string;
DEFINE FIELD org_id          ON dev_activity TYPE string;
DEFINE FIELD branch          ON dev_activity TYPE option<string>;
DEFINE FIELD repo            ON dev_activity TYPE option<string>;
DEFINE FIELD modified_symbols ON dev_activity TYPE option<array<string>>;
DEFINE FIELD modified_files   ON dev_activity TYPE option<array<string>>;
DEFINE FIELD last_active     ON dev_activity TYPE datetime DEFAULT time::now();
DEFINE INDEX idx_dev         ON dev_activity FIELDS developer, org_id;

-- ─── ADDITIONAL NAMESPACES (Multi-Project) ──────────────────────────────────

DEFINE NAMESPACE IF NOT EXISTS mira;
DEFINE NAMESPACE IF NOT EXISTS inspectai;
DEFINE NAMESPACE IF NOT EXISTS videosnap;
