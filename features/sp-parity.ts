import { DataSource } from 'typeorm';

/**
 * DB-level parity: run the legacy stored procedure and the ported TypeORM code against the
 * SAME database and diff the results.
 *
 * HTTP-level comparison needs both APIs reachable from the test environment, which isn't
 * always true. Diffing at the procedure boundary still proves the part that actually carries
 * the logic — values AND column order — and for writes it can do so inside a transaction that
 * is rolled back, touching no rows.
 *
 * Self-skips unless SP_PARITY=1 plus DB credentials are present, so CI stays green. Set
 * SP_PARITY_REQUIRED=1 to turn a missing environment into a failure instead.
 */

export const SP_PARITY_ENABLED = process.env.SP_PARITY === '1';
export const SP_PARITY_REQUIRED = process.env.SP_PARITY_REQUIRED === '1';

export interface SpParityEnv {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}

export function spParityEnv(): SpParityEnv | null {
    const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
    if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) return null;
    return {
        host: DB_HOST,
        port: Number(DB_PORT ?? 3306),
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
    };
}

export async function openDataSource(env: SpParityEnv): Promise<DataSource> {
    const ds = new DataSource({
        type: 'mysql',
        host: env.host,
        port: env.port,
        username: env.user,
        password: env.password,
        database: env.database,
        entities: [],
        synchronize: false,
        logging: false,
    });
    await ds.initialize();
    return ds;
}

const paramCache = new Map<string, string[]>();

/** The proc's real positional parameter list, read from the server rather than assumed. */
export async function procParams(ds: DataSource, proc: string): Promise<string[]> {
    const cached = paramCache.get(proc);
    if (cached) return cached;
    const rows = await ds.query(
        `SELECT PARAMETER_NAME FROM information_schema.PARAMETERS
          WHERE SPECIFIC_SCHEMA = DATABASE() AND SPECIFIC_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [proc],
    ) as { PARAMETER_NAME: string }[];
    const names = rows.map((r) => r.PARAMETER_NAME);
    paramCache.set(proc, names);
    return names;
}

/**
 * Binds by field name the way the legacy caller did, turning BOTH `undefined` and `''` into
 * NULL — so a test can pass the same field object to the procedure and to the port.
 */
export async function callProc(
    ds: DataSource, proc: string, fields: Record<string, unknown>,
): Promise<unknown[]> {
    const names = await procParams(ds, proc);
    const values = names.map((name) => {
        const value = fields[name.replace(/^var_/, '')];
        return value === undefined || value === '' ? null : value;
    });
    const sql = `CALL \`${proc}\`(${names.map(() => '?').join(',')})`;
    return await ds.query(sql, values) as unknown[];
}

/** The first result set of a CALL — the rows the legacy API actually returned. */
export function procRows(result: unknown): Record<string, unknown>[] {
    if (!Array.isArray(result)) return [];
    const first = result[0];
    return Array.isArray(first) ? first as Record<string, unknown>[] : result as Record<string, unknown>[];
}

/** The OK packet of a CALL, carrying the aggregate affectedRows the legacy API gated on. */
export function procPacket(result: unknown): { affectedRows?: number } {
    if (!Array.isArray(result)) return result as { affectedRows?: number };
    return result[result.length - 1] as { affectedRows?: number };
}

export interface NormaliseOptions {
    /** Column names whose values are volatile (generated ids, timestamps, UUIDs). */
    volatile?: string[];
}

/**
 * Canonical form for comparison. Dates become ISO strings so a Date and its serialisation
 * compare equal, and volatile columns collapse to a marker — auto-increment ids differ between
 * two rolled-back transactions because a rollback does not reclaim them.
 */
export function normalise(
    rows: Record<string, unknown>[], options: NormaliseOptions = {},
): string {
    const volatile = new Set(options.volatile ?? []);
    return JSON.stringify(rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(row)) {
            const value = row[key];
            if (volatile.has(key)) out[key] = value === null ? null : 'VOLATILE';
            else if (value instanceof Date) out[key] = value.toISOString();
            else out[key] = value;
        }
        return out;
    }));
}

export interface DiffResult {
    match: boolean;
    reason?: string;
}

/** Diffs values AND column order — key order is part of byte parity. */
export function diffRows(
    legacyRows: Record<string, unknown>[], portedRows: Record<string, unknown>[],
    options: NormaliseOptions = {},
): DiffResult {
    const k1 = Object.keys(legacyRows[0] ?? {});
    const k2 = Object.keys(portedRows[0] ?? {});
    if (JSON.stringify(k1) !== JSON.stringify(k2)) {
        const onlyLegacy = k1.filter((k) => !k2.includes(k));
        const onlyPorted = k2.filter((k) => !k1.includes(k));
        const positional = k1.findIndex((k, i) => k !== k2[i]);
        return {
            match: false,
            reason: `column mismatch: only-legacy=[${onlyLegacy}] only-ported=[${onlyPorted}]`
                + (onlyLegacy.length === 0 && onlyPorted.length === 0
                    ? ` first positional difference at ${positional}: ${k1[positional]} vs ${k2[positional]}`
                    : ''),
        };
    }
    if (legacyRows.length !== portedRows.length) {
        return { match: false, reason: `row count ${legacyRows.length} vs ${portedRows.length}` };
    }
    const a = normalise(legacyRows, options);
    const b = normalise(portedRows, options);
    if (a === b) return { match: true };

    for (let i = 0; i < legacyRows.length; i++) {
        for (const key of k1) {
            const x = normalise([legacyRows[i]], options);
            const y = normalise([portedRows[i]], options);
            if (x !== y) {
                const xv = JSON.stringify(legacyRows[i][key]);
                const yv = JSON.stringify(portedRows[i][key]);
                if (xv !== yv) return { match: false, reason: `row ${i}.${key}: legacy=${xv} ported=${yv}` };
            }
        }
    }
    return { match: false, reason: 'values differ' };
}

/**
 * Runs `work` inside a transaction that is ALWAYS rolled back, so a write diff can be taken
 * against real rows without keeping any.
 *
 * **`work` receives a `dataSource` shim, and any service under test MUST be constructed with
 * it — not with the real DataSource.** A service that calls `this.dataSource.query()` takes a
 * different pooled connection, which is OUTSIDE this transaction and therefore COMMITS — an
 * easy mistake that silently writes to the test database. The shim makes the transactional
 * connection the only one reachable from inside the callback.
 */
export interface TxDataSource {
    query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function inRolledBackTransaction<T>(
    ds: DataSource,
    work: (tx: TxDataSource) => Promise<T>,
): Promise<T> {
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
        return await work({ query: (sql, params) => runner.query(sql, params) });
    } finally {
        await runner.rollbackTransaction();
        await runner.release();
    }
}
