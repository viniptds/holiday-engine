/**
 * TEST ONLY (excluded from the build): a small in-memory stand-in for the TypeORM repository and
 * EntityManager calls the app services make. It supports equality and the FindOperators we use
 * (In, IsNull, Not, MoreThan, LessThan and the OrEqual variants), primary/unique keys, including
 * partial ones (a violation, on insert or update, throws `{ code: '23505' }` like Postgres), ON DELETE
 * CASCADE, many-to-one relations, ordering, and transactions that roll back only their own changes, so
 * concurrent transactions can interleave.
 *
 * Row locks work like Postgres under READ COMMITTED: `find` with `lock`, `update`, `delete` and `save`
 * lock the rows they match until the transaction ends (a statement outside a transaction holds them
 * only for itself). A transaction that waits for another one re-checks each row against its
 * conditions once it gets the lock, and a lock cycle throws a deadlock error (`40P01`).
 * `query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])` takes a transaction-level advisory
 * lock with the same waiting and deadlock rules.
 */
import { randomUUID } from 'node:crypto';
import { FindOperator } from 'typeorm';

type Row = Record<string, unknown>;
type EntityClass<T = object> = new () => T;
type Where = Row | Row[];
type FindOptions = { where?: Where; order?: Row; relations?: Record<string, boolean>; take?: number; lock?: unknown };

/** A unique key: columns, optionally only over rows matching `where` (a partial unique index). */
export type UniqueKey = string[] | { name: string; columns: string[]; where: (row: Row) => boolean };

export type TableSpec = {
  primary: string[];
  unique?: UniqueKey[];
  /** Values the database would generate on insert (ids, defaults, create dates). */
  generate?: () => Row;
  /** Column refreshed on every save/update, like `@UpdateDateColumn`. */
  updateDate?: string;
  /** Soft-delete column, like `@DeleteDateColumn`: rows with it set are hidden from reads. */
  deleteDate?: string;
  /**
   * Many-to-one relations: property -> (target entity, local column holding the target's `id`).
   * Deleting the target cascades, or with `onDelete: 'SET NULL'` clears the column.
   */
  relations?: Record<string, { entity: EntityClass; column: string; onDelete?: 'CASCADE' | 'SET NULL' }>;
};

type Table = { entity: EntityClass; spec: TableSpec; rows: Row[] };
type Undo = () => void;

/** A transaction, or a single statement outside one: owns row and advisory locks until `end()`. */
export class Txn {
  readonly undo: Undo[] = [];
  waitingFor?: Txn;
  private finish!: () => void;
  readonly done = new Promise<void>((resolve) => (this.finish = resolve));
  end() {
    this.finish();
  }
}

export class UniqueViolationError extends Error {
  readonly code = '23505';
  constructor(
    message: string,
    readonly constraint?: string,
  ) {
    super(message);
  }
}

export class DeadlockError extends Error {
  readonly code = '40P01';
}

/** Deep copy of row values (Dates, arrays, plain objects). Not `structuredClone`: under Jest it returns Dates of another realm. */
function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  }
  return value;
}

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
const comparable = (value: unknown) => (value instanceof Date ? value.getTime() : (value as number | string));

function test(value: unknown, condition: unknown): boolean {
  if (!(condition instanceof FindOperator)) return same(value, condition);
  const operand = condition.value as unknown;
  switch (condition.type) {
    case 'isNull':
      return value === null || value === undefined;
    case 'in':
      return (operand as unknown[]).some((v) => same(value, v));
    case 'not':
      return !test(value, operand);
    case 'moreThan':
      return value != null && comparable(value) > comparable(operand);
    case 'moreThanOrEqual':
      return value != null && comparable(value) >= comparable(operand);
    case 'lessThan':
      return value != null && comparable(value) < comparable(operand);
    case 'lessThanOrEqual':
      return value != null && comparable(value) <= comparable(operand);
    default:
      throw new Error(`InMemoryDb: unsupported operator ${condition.type}`);
  }
}

const matches = (row: Row, where: Where | undefined): boolean =>
  where === undefined
    ? true
    : Array.isArray(where)
      ? where.some((w) => matches(row, w))
      : Object.entries(where).every(([key, condition]) => test(row[key], condition));

export class InMemoryDb {
  private readonly tables = new Map<EntityClass, Table>();
  /** Awaited after every read; tests use it to make concurrent requests interleave. */
  afterRead?: (entity: EntityClass) => Promise<void>;
  /** Called before every write; throw from it to simulate a database failure. */
  beforeWrite?: (operation: 'insert' | 'update' | 'delete', entity: EntityClass) => void;

  define(entity: EntityClass, spec: TableSpec): this {
    this.tables.set(entity, { entity, spec, rows: [] });
    return this;
  }

  /** Empties every table. */
  clear() {
    for (const table of this.tables.values()) table.rows = [];
  }

  /** Copies of the stored rows. */
  all<T extends object>(entity: EntityClass<T>, where?: Where): T[] {
    return this.table(entity).rows.filter((r) => matches(r, where)).map((r) => this.toEntity(entity, r));
  }

  /** Inserts directly (no transaction); returns the stored row as an entity. */
  seed<T extends object>(entity: EntityClass<T>, data: Partial<T>): T {
    return this.insertRow(entity, data as Row, null) as T;
  }

  /** A repository bound to `entity`, as `@InjectRepository` would provide. */
  repository<T extends object>(entity: EntityClass<T>) {
    const manager = this.manager(null);
    return {
      manager: { transaction: <R>(work: (m: ReturnType<InMemoryDb['manager']>) => Promise<R>) => this.transaction(work) },
      create: (data: Partial<T>) => manager.create(entity, data),
      find: (options: FindOptions = {}) => manager.find(entity, options),
      findOne: (options: FindOptions) => manager.findOne(entity, options),
      findOneBy: (where: Where) => manager.findOne(entity, { where }),
      count: (options: FindOptions = {}) => manager.count(entity, options),
      save: (value: T) => manager.save(value),
      insert: (values: Partial<T>) => manager.insert(entity, values),
      update: (where: Where, values: Partial<T>) => manager.update(entity, where, values),
      delete: (where: Where) => manager.delete(entity, where),
      softDelete: (where: Where) => manager.softDelete(entity, where),
    };
  }

  async transaction<R>(work: (manager: ReturnType<InMemoryDb['manager']>) => Promise<R>): Promise<R> {
    const txn = new Txn();
    try {
      return await work(this.manager(txn));
    } catch (error) {
      for (const step of txn.undo.reverse()) step();
      throw error;
    } finally {
      // Row locks and (like Postgres) transaction-level advisory locks end at commit or rollback.
      this.release(txn);
    }
  }

  // Transaction-level advisory locks (`pg_advisory_xact_lock`), keyed by the text the SQL hashes.
  // Postgres keys them by hashtext(), so distinct texts can collide there; that only adds waiting.
  // They share the row locks' waiting and deadlock detection, as in Postgres.
  private readonly advisoryLocks = new Map<string, Txn>();

  /** Waits until `txn` holds the advisory lock on `key`. Re-entrant, like Postgres. */
  private async acquireAdvisoryLock(key: string, txn: Txn): Promise<void> {
    for (;;) {
      const holder = this.advisoryLocks.get(key);
      if (!holder || holder === txn) {
        this.advisoryLocks.set(key, txn);
        return;
      }
      for (let t: Txn | undefined = holder; t; t = t.waitingFor) {
        if (t === txn) throw new DeadlockError('deadlock detected');
      }
      txn.waitingFor = holder;
      await holder.done;
      txn.waitingFor = undefined;
    }
  }

  /** The raw SQL the fake understands: only `SELECT pg_advisory_xact_lock(hashtext($1))`. */
  private async query(sql: string, params: unknown[], txn: Txn | null): Promise<unknown[]> {
    if (!/^\s*SELECT pg_advisory_xact_lock\(hashtext\(\$1\)\)\s*;?\s*$/i.test(sql)) {
      throw new Error(`InMemoryDb: unsupported query: ${sql}`);
    }
    const key = String(params[0]);
    if (txn) {
      await this.acquireAdvisoryLock(key, txn);
    } else {
      // Outside a transaction Postgres takes the lock and releases it when the statement ends.
      const own = new Txn();
      try {
        await this.acquireAdvisoryLock(key, own);
      } finally {
        this.release(own);
      }
    }
    return [{ pg_advisory_xact_lock: '' }];
  }

  /** EntityManager-like API. Inside a transaction (`txn`), changes are recorded so it can roll back. */
  manager(txn: Txn | null) {
    const db = this;
    /** Runs one statement: inside the transaction, or as its own (locks released right after). */
    const statement = async <R>(work: (t: Txn) => Promise<R>): Promise<R> => {
      if (txn) return work(txn);
      const own = new Txn();
      try {
        return await work(own);
      } finally {
        db.release(own);
      }
    };
    const undo = txn?.undo ?? null;
    return {
      create<T extends object>(entity: EntityClass<T>, data: Partial<T>): T {
        return Object.assign(new entity(), data);
      },
      async find<T extends object>(entity: EntityClass<T>, options: FindOptions = {}): Promise<T[]> {
        if (options.lock !== undefined) {
          // Like TypeORM: a pessimistic lock needs a transaction.
          if (!txn) throw new Error('InMemoryDb: a pessimistic lock requires a transaction');
          await db.lockMatching(db.table(entity), options.where, txn);
        }
        const result = db.select(entity, options);
        await db.afterRead?.(entity);
        return result;
      },
      async findOne<T extends object>(entity: EntityClass<T>, options: FindOptions): Promise<T | null> {
        return (await this.find(entity, { ...options, take: 1 }))[0] ?? null;
      },
      async count<T extends object>(entity: EntityClass<T>, options: FindOptions = {}): Promise<number> {
        return db.select(entity, options).length;
      },
      async save<T extends object>(value: T): Promise<T> {
        const entity = value.constructor as EntityClass<T>;
        const table = db.table(entity);
        const byKey = (r: Row) => table.spec.primary.every((k) => k in value && same(r[k], (value as Row)[k]));
        const existing = table.rows.find(byKey);
        if (existing) {
          return statement(async (t) => {
            await db.acquire(existing, t);
            const changes = db.columns(table, value as Row);
            db.updateRows(table, [existing], changes, undo);
            return Object.assign(value, db.toEntity(entity, existing));
          });
        }
        return Object.assign(value, db.insertRow(entity, value as Row, undo));
      },
      async insert<T extends object>(entity: EntityClass<T>, values: Partial<T>) {
        const row = db.insertRow(entity, values as Row, undo) as Row;
        return { identifiers: [Object.fromEntries(db.table(entity).spec.primary.map((k) => [k, row[k]]))] };
      },
      async update<T extends object>(entity: EntityClass<T>, where: Where, values: Partial<T>) {
        const table = db.table(entity);
        return statement(async (t) => {
          const rows = await db.lockMatching(table, where, t);
          db.updateRows(table, rows, values as Row, undo);
          return { affected: rows.length };
        });
      },
      async delete<T extends object>(entity: EntityClass<T>, where: Where) {
        const table = db.table(entity);
        return statement(async (t) => {
          const rows = await db.lockMatching(table, where, t);
          for (const row of rows) db.deleteRow(table, row, undo);
          return { affected: rows.length };
        });
      },
      async softDelete<T extends object>(entity: EntityClass<T>, where: Where) {
        const table = db.table(entity);
        const column = table.spec.deleteDate;
        if (!column) throw new Error(`InMemoryDb: ${entity.name} has no deleteDate`);
        return statement(async (t) => {
          const rows = (await db.lockMatching(table, where, t)).filter((r) => r[column] == null);
          db.updateRows(table, rows, { [column]: new Date() }, undo);
          return { affected: rows.length };
        });
      },
      query(sql: string, params: unknown[] = []): Promise<unknown[]> {
        return db.query(sql, params, txn);
      },
      getRepository<T extends object>(entity: EntityClass<T>) {
        const m = this;
        return {
          create: (data: Partial<T>) => m.create(entity, data),
          save: (value: T) => m.save(value),
          find: (options: FindOptions = {}) => m.find(entity, options),
          findOne: (options: FindOptions) => m.findOne(entity, options),
          update: (where: Where, values: Partial<T>) => m.update(entity, where, values),
          delete: (where: Where) => m.delete(entity, where),
          insert: (values: Partial<T>) => m.insert(entity, values),
        };
      },
    };
  }

  private readonly locks = new Map<Row, Txn>();

  /**
   * Locks every row matching `where` for `txn`, waiting for other holders, then re-checks each row
   * (it may have changed or gone meanwhile) and returns those that still match.
   */
  private async lockMatching(table: Table, where: Where | undefined, txn: Txn): Promise<Row[]> {
    const candidates = table.rows.filter((r) => matches(r, where));
    for (const row of candidates) await this.acquire(row, txn);
    return candidates.filter((r) => table.rows.includes(r) && matches(r, where));
  }

  private async acquire(row: Row, txn: Txn): Promise<void> {
    for (;;) {
      const holder = this.locks.get(row);
      if (!holder || holder === txn) {
        this.locks.set(row, txn);
        return;
      }
      for (let t: Txn | undefined = holder; t; t = t.waitingFor) {
        if (t === txn) throw new DeadlockError('deadlock detected');
      }
      txn.waitingFor = holder;
      await holder.done;
      txn.waitingFor = undefined;
    }
  }

  private release(txn: Txn) {
    for (const [row, holder] of this.locks) if (holder === txn) this.locks.delete(row);
    for (const [key, holder] of this.advisoryLocks) if (holder === txn) this.advisoryLocks.delete(key);
    txn.end();
  }

  /** Throws like Postgres if `row` collides with another row on a (possibly partial) unique key. */
  private checkUnique(table: Table, row: Row) {
    const keys: UniqueKey[] = [table.spec.primary, ...(table.spec.unique ?? [])];
    for (const key of keys) {
      const { columns, where, name } = Array.isArray(key) ? { columns: key, where: undefined, name: undefined } : key;
      if (where && !where(row)) continue;
      const clash = table.rows.some(
        (r) => r !== row && (!where || where(r)) && columns.every((k) => same(r[k], row[k])),
      );
      if (clash) {
        throw new UniqueViolationError(
          `duplicate key value violates unique constraint ${name ?? ''} on ${table.entity.name} (${columns.join(', ')})`.replace('  ', ' '),
          name,
        );
      }
    }
  }

  private table(entity: EntityClass): Table {
    const table = this.tables.get(entity);
    if (!table) throw new Error(`InMemoryDb: ${entity.name} is not defined`);
    return table;
  }

  /** Stored columns only: drops relation properties and undefined values. */
  private columns(table: Table, value: Row): Row {
    const relations = Object.keys(table.spec.relations ?? {});
    return Object.fromEntries(Object.entries(value).filter(([k, v]) => v !== undefined && !relations.includes(k)));
  }

  private toEntity<T extends object>(entity: EntityClass<T>, row: Row): T {
    return Object.assign(new entity(), clone(row));
  }

  private select<T extends object>(entity: EntityClass<T>, { where, order, relations, take }: FindOptions): T[] {
    const table = this.table(entity);
    const withRelations = (row: Row): Row => {
      const out: Row = { ...row };
      for (const [name, enabled] of Object.entries(relations ?? {})) {
        const relation = table.spec.relations?.[name];
        if (!enabled || !relation) continue;
        const target = this.table(relation.entity).rows.find((r) => same(r.id, row[relation.column]));
        out[name] = target ? this.toEntity(relation.entity, target) : null;
      }
      return out;
    };
    const live = (r: Row) => !table.spec.deleteDate || r[table.spec.deleteDate] == null;
    const rows = table.rows.filter((r) => live(r) && matches(r, where)).map(withRelations);
    if (order) rows.sort((a, b) => compareBy(a, b, order));
    const picked = take === undefined ? rows : rows.slice(0, take);
    return picked.map((r) => {
      const { ...plain } = r;
      const loaded: Row = {};
      for (const name of Object.keys(table.spec.relations ?? {})) {
        if (name in plain) {
          loaded[name] = plain[name];
          delete plain[name];
        }
      }
      return Object.assign(this.toEntity(entity, plain), loaded);
    });
  }

  private insertRow(entity: EntityClass, value: Row, undo: Undo[] | null): object {
    this.beforeWrite?.('insert', entity);
    const table = this.table(entity);
    const row: Row = { ...table.spec.generate?.(), ...clone(this.columns(table, value)) };
    this.checkUnique(table, row);
    table.rows.push(row);
    undo?.push(() => {
      table.rows = table.rows.filter((r) => r !== row);
    });
    return this.toEntity(entity, row);
  }

  private updateRows(table: Table, rows: Row[], values: Row, undo: Undo[] | null) {
    this.beforeWrite?.('update', table.entity);
    const changes = { ...clone(values), ...(table.spec.updateDate ? { [table.spec.updateDate]: new Date() } : {}) };
    const applied: [Row, Row][] = [];
    try {
      for (const row of rows) {
        const before = Object.fromEntries(Object.keys(changes).map((k) => [k, row[k]]));
        Object.assign(row, changes);
        applied.push([row, before]);
        // Checked row by row, like a non-deferrable unique index.
        this.checkUnique(table, row);
      }
    } catch (error) {
      // The statement fails as a whole.
      for (const [row, before] of applied.reverse()) Object.assign(row, before);
      throw error;
    }
    for (const [row, before] of applied) undo?.push(() => Object.assign(row, before));
  }

  private deleteRow(table: Table, row: Row, undo: Undo[] | null) {
    this.beforeWrite?.('delete', table.entity);
    table.rows = table.rows.filter((r) => r !== row);
    undo?.push(() => table.rows.push(row));
    // ON DELETE CASCADE for every relation pointing at this table.
    for (const child of this.tables.values()) {
      for (const relation of Object.values(child.spec.relations ?? {})) {
        if (relation.entity !== table.entity) continue;
        for (const dependent of child.rows.filter((r) => same(r[relation.column], row.id))) {
          if (relation.onDelete === 'SET NULL') {
            const before = dependent[relation.column];
            dependent[relation.column] = null;
            undo?.push(() => (dependent[relation.column] = before));
          } else {
            this.deleteRow(child, dependent, undo);
          }
        }
      }
    }
  }
}

function compareBy(a: Row, b: Row, order: Row): number {
  for (const [key, direction] of Object.entries(order)) {
    if (typeof direction === 'object' && direction !== null) {
      const result = compareBy((a[key] ?? {}) as Row, (b[key] ?? {}) as Row, direction as Row);
      if (result !== 0) return result;
      continue;
    }
    const [x, y] = [comparable(a[key]), comparable(b[key])];
    if (x === y) continue;
    const result = x < y ? -1 : 1;
    return String(direction).toUpperCase() === 'DESC' ? -result : result;
  }
  return 0;
}

/** Resolves once `count` callers are waiting: makes concurrent requests reach the same point together. */
export function barrier(count: number): () => Promise<void> {
  let waiting = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  return () => {
    waiting += 1;
    if (waiting >= count) release();
    return ready;
  };
}

export const newId = () => randomUUID();
