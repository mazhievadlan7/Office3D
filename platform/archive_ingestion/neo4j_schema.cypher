// AEGIS / Office3D — Neo4j схема Архива
// Модель: (Domain)-[:CONTAINS]->(Unit)-[:AT_LEVEL]->(Level)
//         (Governance) правила первого уровня, (Loop) контуры саморазвития

CREATE CONSTRAINT unit_id     IF NOT EXISTS FOR (u:Unit)       REQUIRE u.id IS UNIQUE;
CREATE CONSTRAINT domain_name IF NOT EXISTS FOR (d:Domain)     REQUIRE d.name IS UNIQUE;
CREATE CONSTRAINT level_n     IF NOT EXISTS FOR (l:Level)      REQUIRE l.n IS UNIQUE;
CREATE CONSTRAINT gov_rule    IF NOT EXISTS FOR (g:Governance) REQUIRE g.rule_id IS UNIQUE;
CREATE CONSTRAINT loop_id     IF NOT EXISTS FOR (x:Loop)       REQUIRE x.id IS UNIQUE;

// Полезные запросы -----------------------------------------------------------

// Все единицы домена по возрастанию уровня:
//   MATCH (d:Domain {name:'ad-identity'})-[:CONTAINS]->(u:Unit)-[:AT_LEVEL]->(l:Level)
//   RETURN u.name, u.unit_type, l.n ORDER BY l.n;

// Учебная лестница по домену (L1→L5), только книги:
//   MATCH (d:Domain {name:'offensive-web'})-[:CONTAINS]->(u:Unit {unit_type:'book'})-[:AT_LEVEL]->(l:Level)
//   RETURN l.n AS level, collect(u.name) AS books ORDER BY level;

// Правила первого уровня (governance):
//   MATCH (g:Governance) RETURN g.rule_id, g.text ORDER BY g.rule_id;

// Контуры саморазвития и их границы:
//   MATCH (x:Loop) RETURN x.id, x.name, x.freq, x.boundary ORDER BY x.id;
