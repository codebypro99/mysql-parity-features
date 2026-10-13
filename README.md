# MySQL Legacy Compatibility and Parity Feature Samples

TypeScript and TypeORM utilities supporting migration from MySQL stored procedures to application-side database logic.

## Purpose

These samples show how I isolate database compatibility behavior and build reusable comparison utilities for validating a rewrite against legacy procedure results.

## Session SQL Mode Compatibility

**Source:** [legacy-sql-mode.ts](./features/legacy-sql-mode.ts)

The withLegacySqlMode helper acquires a dedicated QueryRunner, reads its current session SQL mode, sets NO_AUTO_VALUE_ON_ZERO, and invokes a supplied callback on that runner. It attempts to restore the previous mode before releasing the connection.

The assertProcIntParam helper accepts nullish values, finite numbers, and signed numeric strings with an optional decimal portion. Other values produce an Error carrying MySQL-style sqlState, errno, and code fields for the surrounding exception mapper.

**What this demonstrates:** making migration-specific session behavior and input compatibility explicit rather than spreading it across ported service methods.

**Behavior boundaries:** the mode helper does not start a transaction. The callback must use the supplied runner to inherit its session settings. A restoration error can replace a callback error, and connection release is attempted even if restoration fails. The parameter helper does not enforce integer-only values, BIGINT range, or all MySQL conversion rules; its driver-like error is constructed in application code.

## Stored Procedure Comparison Utilities

**Source:** [sp-parity.ts](./features/sp-parity.ts)

### Environment and Procedure Calls

- Exposes parity-enabled and parity-required environment flags for consuming tests.
- Reads connection settings from environment variables and opens a MySQL DataSource with synchronization disabled.
- Discovers procedure parameter names in ordinal order through information_schema.
- Caches parameter names by procedure name.
- Maps field names to positional arguments, removes the var_ prefix, and converts undefined and empty strings to null.
- Extracts the first result set and final response packet from procedure-call results.

### Result Comparison

- Converts Date values to ISO strings.
- Replaces selected volatile values with a marker while retaining null values.
- Compares first-row column names and order, row counts, and normalized row serialization.
- Reports a mismatch reason, including missing columns, order differences, or differing values.

### Transaction-Scoped Write Checks

The inRolledBackTransaction helper starts a transaction and supplies a query-only adapter bound to its QueryRunner. After the callback it attempts rollback and connection release, allowing consuming comparisons to avoid retaining transactional writes.

**What this demonstrates:** creating reusable parity-test building blocks for procedure calls, result normalization, and transaction-scoped rewrite checks.

## Technologies

TypeScript, TypeORM DataSource and QueryRunner, MySQL session settings, information_schema, parameterized SQL values, and JSON-based result comparison.

## Excerpt Context and Behavior Boundaries

Legacy procedures, rewritten services, actual comparison cases, database schema, credentials, and test orchestration belong to the surrounding application. The exported flags do not themselves skip tests or enforce required configuration.

Procedure names are interpolated as SQL identifiers rather than validated or bound values, so callers must supply trusted names. The parameter cache is not scoped by database. Comparisons preserve row order and mask only explicitly named top-level volatile fields; masking does not prove those fields are equivalent.

Rollback applies to work performed on the supplied transactional connection and supported transactional operations. It cannot undo external effects or independently committed connections. Connection setup and rollback failures are not fully protected by nested cleanup blocks in this helper.

Original source code is preserved. Descriptions are based on source inspection. No database connections, procedure calls, or write comparisons were executed for this collection.

## Portfolio Message

I can support database rewrites with explicit compatibility adapters and comparison tooling that checks both returned values and result structure.
