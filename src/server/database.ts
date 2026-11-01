import { Context, Effect, Schema } from "effect";

/**
 * D1, as an Effect service. SQL stays plain SQL: every method takes the statement and its
 * parameters. Failures are `DatabaseError`; `isConstraint` tells unique and primary key
 * violations apart, so callers can answer 409 for them.
 */

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {
  /** A UNIQUE or PRIMARY KEY constraint failed. */
  get isConstraint() {
    return /UNIQUE|PRIMARY KEY/i.test(`${this.message} ${String(this.cause)}`);
  }
}

const toDatabaseError = (cause: unknown) =>
  new DatabaseError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** A statement for `Database.batch`. Build it with `sql`. */
export type Statement = { readonly sql: string; readonly params: ReadonlyArray<unknown> };

export const sql = (text: string, ...params: Array<unknown>): Statement => ({
  sql: text,
  params,
});

export type RunResult = { readonly changes: number };

export class Database extends Context.Service<
  Database,
  {
    /** The first row, or null. */
    readonly first: <T = Record<string, unknown>>(
      sql: string,
      ...params: Array<unknown>
    ) => Effect.Effect<T | null, DatabaseError>;
    readonly all: <T = Record<string, unknown>>(
      sql: string,
      ...params: Array<unknown>
    ) => Effect.Effect<Array<T>, DatabaseError>;
    readonly run: (
      sql: string,
      ...params: Array<unknown>
    ) => Effect.Effect<RunResult, DatabaseError>;
    /** One transaction: every statement applies, or none does. */
    readonly batch: (
      statements: ReadonlyArray<Statement>,
    ) => Effect.Effect<Array<RunResult>, DatabaseError>;
  }
>()("nap/Database") {
  static make(db: D1Database): Database["Service"] {
    const prepare = (text: string, params: ReadonlyArray<unknown>) =>
      db.prepare(text).bind(...params);
    return Database.of({
      first: <T>(text: string, ...params: Array<unknown>) =>
        Effect.tryPromise({
          try: () => prepare(text, params).first<T>(),
          catch: toDatabaseError,
        }),
      all: <T>(text: string, ...params: Array<unknown>) =>
        Effect.tryPromise({
          try: () => prepare(text, params).all<T>(),
          catch: toDatabaseError,
        }).pipe(Effect.map((result) => result.results)),
      run: (text: string, ...params: Array<unknown>) =>
        Effect.tryPromise({
          try: () => prepare(text, params).run(),
          catch: toDatabaseError,
        }).pipe(Effect.map((result) => ({ changes: result.meta.changes }))),
      batch: (statements) =>
        statements.length === 0
          ? Effect.succeed([])
          : Effect.tryPromise({
              try: () => db.batch(statements.map((s) => prepare(s.sql, s.params))),
              catch: toDatabaseError,
            }).pipe(
              Effect.map((results) => results.map((result) => ({ changes: result.meta.changes }))),
            ),
    });
  }
}
