/**
 * TEST ONLY (excluded from the build): a small in-memory stand-in for the TypeORM repository and
 * EntityManager calls the app services make. It supports equality and the FindOperators we use
 * (In, IsNull, Not, MoreThan, LessThan and the OrEqual variants), primary/unique keys (a violation
 * throws `{ code: '23505' }` like Postgres), ON DELETE CASCADE, many-to-one relations, ordering,
 * and transactions that roll back only their own changes, so concurrent transactions can interleave.
 */
import { randomUUID } from 'node:crypto';
import { FindOperator } from 'typeorm';

type Row = Record<string, unknown>;
type EntityClass<T = object> = new () => T;
type Where = Row | Row[];
type FindOptions = { where?: Where; order?: Row; relations?: Record<string, boolean>; take?: number; lock?: unknown };

export type TableSpec = {
  primary: string[];
  unique?: string[][];
  /** Values the database would generate on insert (ids, defaults, create dates). */
  generate?: () => Row;
  /** Column refreshed on every save/update, like `@UpdateDateColumn`. */
  updateDate?: string;
  /** Soft-delete column, like `@DeleteDateColumn`: rows with it set are hidden from reads. */
  deleteDate?: string;
  /** Many-to-one relations: property -> (target entity, local column holding the target's `id`). */
  relations?: Record<string, { entity: EntityClass; column: string }>;
};

type Table = { entity: EntityClass; spec: TableSpec; rows: Row[] };
type Undo = () => void;

export class UniqueViolationError extends Error {
  readonly code = '23505';
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
    const undo: Undo[] = [];
    try {
      return await work(this.manager(undo));
    } catch (error) {
      for (const step of undo.reverse()) step();
      throw error;
    }
  }

  /** EntityManager-like API. With `undo`, changes are recorded so the transaction can roll back. */
  manager(undo: Undo[] | null) {
    const db = this;
    return {
      create<T extends object>(entity: EntityClass<T>, data: Partial<T>): T {
        return Object.assign(new entity(), data);
      },
      async find<T extends object>(entity: EntityClass<T>, options: FindOptions = {}): Promise<T[]> {
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
        const existing = table.rows.find((r) => table.spec.primary.every((k) => k in value && same(r[k], (value as Row)[k])));
        if (existing) {
          const changes = db.columns(table, value as Row);
          db.updateRows(table, [existing], changes, undo);
          return Object.assign(value, db.toEntity(entity, existing));
        }
        return Object.assign(value, db.insertRow(entity, value as Row, undo));
      },
      async insert<T extends object>(entity: EntityClass<T>, values: Partial<T>) {
        const row = db.insertRow(entity, values as Row, undo) as Row;
        return { identifiers: [Object.fromEntries(db.table(entity).spec.primary.map((k) => [k, row[k]]))] };
      },
      async update<T extends object>(entity: EntityClass<T>, where: Where, values: Partial<T>) {
        const table = db.table(entity);
        const rows = table.rows.filter((r) => matches(r, where));
        db.updateRows(table, rows, values as Row, undo);
        return { affected: rows.length };
      },
      async delete<T extends object>(entity: EntityClass<T>, where: Where) {
        const table = db.table(entity);
        const rows = table.rows.filter((r) => matches(r, where));
        for (const row of rows) db.deleteRow(table, row, undo);
        return { affected: rows.length };
      },
      async softDelete<T extends object>(entity: EntityClass<T>, where: Where) {
        const table = db.table(entity);
        const column = table.spec.deleteDate;
        if (!column) throw new Error(`InMemoryDb: ${entity.name} has no deleteDate`);
        const rows = table.rows.filter((r) => r[column] == null && matches(r, where));
        db.updateRows(table, rows, { [column]: new Date() }, undo);
        return { affected: rows.length };
      },
      getRepository<T extends object>(entity: EntityClass<T>) {
        const m = this;
        return {
          find: (options: FindOptions = {}) => m.find(entity, options),
          findOne: (options: FindOptions) => m.findOne(entity, options),
          update: (where: Where, values: Partial<T>) => m.update(entity, where, values),
          delete: (where: Where) => m.delete(entity, where),
          insert: (values: Partial<T>) => m.insert(entity, values),
        };
      },
    };
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
    for (const key of [table.spec.primary, ...(table.spec.unique ?? [])]) {
      if (table.rows.some((r) => key.every((k) => same(r[k], row[k])))) {
        throw new UniqueViolationError(`duplicate key value violates unique constraint on ${entity.name} (${key.join(', ')})`);
      }
    }
    table.rows.push(row);
    undo?.push(() => {
      table.rows = table.rows.filter((r) => r !== row);
    });
    return this.toEntity(entity, row);
  }

  private updateRows(table: Table, rows: Row[], values: Row, undo: Undo[] | null) {
    this.beforeWrite?.('update', table.entity);
    const changes = { ...clone(values), ...(table.spec.updateDate ? { [table.spec.updateDate]: new Date() } : {}) };
    for (const row of rows) {
      const before = Object.fromEntries(Object.keys(changes).map((k) => [k, row[k]]));
      Object.assign(row, changes);
      undo?.push(() => Object.assign(row, before));
    }
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
          this.deleteRow(child, dependent, undo);
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
