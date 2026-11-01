import { Effect } from "effect";
import { guessName, type Guess } from "~/lib/name-guess";
import {
  firstFreeLook,
  isColor,
  isShape,
  lookKey,
  preferredLook,
  type Color,
  type Look,
  type Shape,
} from "~/lib/looks";
import type { Identity } from "~/lib/nap-server";
import { Database } from "~/server/database";
import { fail } from "~/server/http";

/**
 * Names and looks. Everyone has a name and a look (a shape and a colour) that sites read through
 * nap.me(), nap.people(), and channel presence. A profile without a name has not been through
 * the welcome page yet: Nap sends them there on their next page visit.
 */

export type Person = { email: string; name: string; shape: Shape; color: Color };

type Row = {
  email: string;
  name: string | null;
  shape: string | null;
  color: string | null;
};

const PERSON_COLUMNS = `lower(email) AS email, display_name AS name, shape, color`;

const lookOf = (row: Row): Look =>
  isShape(row.shape) && isColor(row.color)
    ? { shape: row.shape, color: row.color }
    : preferredLook(row.email);

const toPerson = (row: Row, fallbackName?: string): Person => ({
  email: row.email,
  name: row.name || fallbackName || nameFromEmail(row.email),
  ...lookOf(row),
});

export function nameFromEmail(email: string) {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._+-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Gives a look to everyone who has none, oldest profile first, so most people keep the look
 * dle gave them. When all 49 are taken, the rest keep none and show their preferred look.
 */
export const assignMissingLooks = Effect.fn("assignMissingLooks")(function* () {
  const db = yield* Database;
  const rows = yield* db.all<Row>(
    `SELECT ${PERSON_COLUMNS} FROM profiles ORDER BY created_at, email`,
  );
  const taken = new Set(
    rows.filter((row) => isShape(row.shape) && isColor(row.color)).map((row) => lookKey(lookOf(row))),
  );
  for (const row of rows) {
    if (isShape(row.shape) && isColor(row.color)) continue;
    const look = firstFreeLook(row.email, taken);
    if (taken.has(lookKey(look))) continue;
    const saved = yield* db
      .run(
        `UPDATE profiles SET shape = ?, color = ? WHERE lower(email) = ? AND shape IS NULL`,
        look.shape,
        look.color,
        row.email,
      )
      .pipe(
        Effect.map((result) => result.changes > 0),
        // Someone else took it a moment ago. They keep it; this person gets one next time.
        Effect.catchIf(
          (error) => error.isConstraint,
          () => Effect.succeed(false),
        ),
      );
    if (saved) taken.add(lookKey(look));
  }
});

/** One person, with their look assigned if they had none. */
export const findPerson = Effect.fn("findPerson")(function* (email: string, fallbackName?: string) {
  const db = yield* Database;
  const key = email.toLowerCase();
  const read = () =>
    db.first<Row>(`SELECT ${PERSON_COLUMNS} FROM profiles WHERE lower(email) = ?`, key);
  let row = yield* read();
  if (row && !(isShape(row.shape) && isColor(row.color))) {
    yield* assignMissingLooks();
    row = yield* read();
  }
  return toPerson(row ?? { email: key, name: null, shape: null, color: null }, fallbackName);
});

/** Everyone who has signed in to Nap, or only these emails. */
export const listPeople = Effect.fn("listPeopleWithLooks")(function* (
  emails?: ReadonlyArray<string>,
) {
  const db = yield* Database;
  let rows = yield* db.all<Row>(`SELECT ${PERSON_COLUMNS} FROM profiles ORDER BY created_at`);
  if (rows.some((row) => !(isShape(row.shape) && isColor(row.color)))) {
    yield* assignMissingLooks();
    rows = yield* db.all<Row>(`SELECT ${PERSON_COLUMNS} FROM profiles ORDER BY created_at`);
  }
  const wanted = emails ? new Set(emails.map((email) => email.trim().toLowerCase())) : null;
  return rows
    .filter((row) => !wanted || wanted.has(row.email))
    .map((row) => toPerson(row));
});

/** True when this person has a profile but no name yet: the welcome page is next. */
export const needsWelcome = Effect.fn("needsWelcome")(function* (email: string) {
  const db = yield* Database;
  const row = yield* db.first<{ name: string | null }>(
    `SELECT display_name AS name FROM profiles WHERE lower(email) = ?`,
    email.toLowerCase(),
  );
  // No profile yet: it is created on this visit, without a name.
  return !row || !row.name;
});

export type WelcomeState = {
  me: Person;
  /** False until the person has picked a name on the welcome page. */
  named: boolean;
  guess: Pick<Guess, "guess" | "score" | "confident">;
  /** Looks other people have. Everything else is free. */
  taken: Array<{ shape: Shape; color: Color; name: string }>;
};

/** What the welcome page needs: the person, a guess at their name, and who has which look. */
export const welcomeState = Effect.fn("welcomeState")(function* (
  identity: Identity,
  providerName: string | null,
) {
  const people = yield* listPeople();
  const email = identity.email.toLowerCase();
  const me = people.find((person) => person.email === email) ?? (yield* findPerson(email));
  const db = yield* Database;
  const row = yield* db.first<{ name: string | null }>(
    `SELECT display_name AS name FROM profiles WHERE lower(email) = ?`,
    email,
  );
  const guess = guessName(email, providerName);
  return {
    me: { ...me, name: row?.name || guess.guess || me.name },
    named: Boolean(row?.name),
    guess: { guess: guess.guess || me.name, score: guess.score, confident: guess.confident },
    taken: people
      .filter((person) => person.email !== email)
      .map((person) => ({ shape: person.shape, color: person.color, name: person.name })),
  } satisfies WelcomeState;
});

/** Saves a name and a look. 409 when someone else has that look. */
export const saveProfile = Effect.fn("saveProfile")(function* (
  identity: Identity,
  input: { name: unknown; shape: unknown; color: unknown },
) {
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!name) return yield* fail(400, "Tell us what to call you");
  if (name.length > 60) return yield* fail(400, "That name is longer than 60 characters");
  if (!isShape(input.shape) || !isColor(input.color)) {
    return yield* fail(400, "Pick a shape and a colour");
  }
  const db = yield* Database;
  yield* db
    .run(
      `UPDATE profiles
       SET display_name = ?, shape = ?, color = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE lower(email) = ?`,
      name,
      input.shape,
      input.color,
      identity.email.toLowerCase(),
    )
    .pipe(
      Effect.catchIf(
        (error) => error.isConstraint,
        () => fail(409, "Someone just took that one. Pick another."),
      ),
    );
  return yield* findPerson(identity.email);
});
