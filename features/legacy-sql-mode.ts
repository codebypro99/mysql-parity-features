import type { DataSource, QueryRunner } from 'typeorm';

/**
 * The sql_mode the legacy stored procedures were CREATED with.
 *
 * MySQL saves sql_mode with a routine and runs its body under that saved mode, ignoring the
 * caller's session. The legacy procedures carry `NO_AUTO_VALUE_ON_ZERO` — no
 * STRICT_TRANS_TABLES — so a value that does not fit its column is silently coerced: an
 * out-of-range ENUM lands as '', an over-long string is truncated, and the write still
 * succeeds. The server's own session mode IS strict, so the same statement issued directly by
 * the rewritten code raises an error and answers 500 where the old API answered 200.
 */
export const LEGACY_PROC_SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

/**
 * Runs `work` on a connection pinned to the procedures' sql_mode, restoring the previous mode
 * before the connection returns to the pool — otherwise the relaxed mode would leak into
 * whichever unrelated request borrows that connection next.
 *
 * Use it for any ported write that lets request text reach a constrained column.
 */
export async function withLegacySqlMode<T>(
    dataSource: DataSource,
    work: (runner: QueryRunner) => Promise<T>,
): Promise<T> {
    const runner = dataSource.createQueryRunner();
    try {
        await runner.connect();
        const rows = await runner.query('SELECT @@SESSION.sql_mode AS sql_mode') as { sql_mode: string }[];
        const previous = rows?.length ? rows[0].sql_mode : '';
        await runner.query('SET SESSION sql_mode = ?', [LEGACY_PROC_SQL_MODE]);
        try {
            return await work(runner);
        } finally {
            await runner.query('SET SESSION sql_mode = ?', [previous]);
        }
    } finally {
        await runner.release();
    }
}

/**
 * The legacy procedures take ids as typed `BIGINT` IN parameters, and parameter assignment
 * happens in the CALLER's session — which is strict. A non-numeric id therefore failed with a
 * MySQL error (answering `{valid:false, message:'Internal Server Error', is_exception:1}`)
 * before ever reaching the lookup.
 *
 * The rewrite binds ids into plain comparisons, where MySQL only warns, so the same request
 * would quietly answer "not found" instead. Call this where the old code passed an id through a
 * typed parameter: it raises an error carrying a real sqlState, which the exception filter
 * renders exactly as before.
 */
export function assertProcIntParam(value: unknown): void {
    if (value === undefined || value === null) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    const text = String(value).trim();
    if (text !== '' && /^[+-]?\d+(\.\d+)?$/.test(text)) return;

    const err = new Error(`Incorrect integer value: '${String(value)}'`) as Error & {
        sqlState?: string; errno?: number; code?: string;
    };
    err.sqlState = '22007';
    err.errno = 1366;
    err.code = 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD';
    throw err;
}
