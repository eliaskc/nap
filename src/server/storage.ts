import { Context, Effect, Schema } from "effect";

/**
 * The R2 bucket that holds every nap's files, drafts, and app builds, as an Effect service.
 */

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const toStorageError = (cause: unknown) =>
  new StorageError({ message: cause instanceof Error ? cause.message : String(cause), cause });

/** Runs an R2 call (or reads an object body) and maps failures to `StorageError`. */
export const tryStorage = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: toStorageError });

export type StoredObject = { key: string; size: number };

export class Storage extends Context.Service<
  Storage,
  {
    readonly get: (
      key: string,
      options?: R2GetOptions,
    ) => Effect.Effect<R2ObjectBody | null, StorageError>;
    readonly head: (key: string) => Effect.Effect<R2Object | null, StorageError>;
    readonly put: (
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
      options?: R2PutOptions,
    ) => Effect.Effect<R2Object | null, StorageError>;
    readonly delete: (keys: string | Array<string>) => Effect.Effect<void, StorageError>;
    /**
     * The key and size of every object below `prefix`, across pages. Only those two, so a
     * version with many files stays small in memory.
     */
    readonly list: (prefix: string) => Effect.Effect<Array<StoredObject>, StorageError>;
  }
>()("nap/Storage") {
  static make(bucket: R2Bucket): Storage["Service"] {
    return Storage.of({
      get: (key, options) =>
        tryStorage(() => bucket.get(key, options) as Promise<R2ObjectBody | null>),
      head: (key) => tryStorage(() => bucket.head(key)),
      put: (key, value, options) => tryStorage(() => bucket.put(key, value, options)),
      delete: (keys) => tryStorage(() => bucket.delete(keys)),
      list: (prefix) =>
        tryStorage(async () => {
          const objects: Array<StoredObject> = [];
          let cursor: string | undefined;
          do {
            const listed = await bucket.list({ prefix, cursor });
            for (const { key, size } of listed.objects) objects.push({ key, size });
            cursor = listed.truncated ? listed.cursor : undefined;
          } while (cursor);
          return objects;
        }),
    });
  }
}

/** The headers R2 stored with an object (content type and so on). */
export function objectHeaders(object: R2Object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  return headers;
}
