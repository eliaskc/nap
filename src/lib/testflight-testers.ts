import { Effect } from "effect";
import { AppleError, appStoreConnect } from "~/lib/apple";
import { testFlightBuild, testFlightConfig, testFlightUrl } from "~/lib/apps";
import type { Identity } from "~/lib/nap-server";
import { Database } from "~/server/database";

/**
 * Get the app: anyone signed in to Nap can ask for the TestFlight launcher from the dashboard.
 *
 * TestFlight's internal testers must be App Store Connect users, so it takes two invites from
 * Apple:
 * 1. Nap invites the person's Apple Account email to the team, with the Marketing role (the least
 *    a tester needs) and access to the Nap app only. Apple emails them; they accept.
 * 2. Once Apple lists them as a user, Nap adds them to the app's internal TestFlight group. Apple
 *    emails a TestFlight invite, and they install from the TestFlight app.
 * People who already are App Store Connect users skip the first step.
 *
 * Nap only learns about step 1 by asking Apple, which it does when the person looks.
 */

/** The least a tester needs. Admins and App Managers are testers already. */
const TESTER_ROLE = "MARKETING";

type TesterRow = { email: string; appleEmail: string; state: "team_invited" | "tester" };

/** Where the person is, for the dashboard. */
export type InstallStatus = {
  enabled: true;
  /** Opens the app in TestFlight on an iPhone. */
  url: string;
  /** The same, as an https link, for QR codes and desktop browsers. */
  webUrl: string;
  /** The Nap sign-in: the usual guess for the Apple Account. */
  napEmail: string;
  appleEmail: string | null;
  step:
    | { kind: "new" }
    | { kind: "team_invited"; pending: boolean }
    | {
        kind: "tester";
        /** Apple's word: invited (the TestFlight email is waiting), accepted, or installed. */
        tester: "invited" | "accepted" | "installed" | null;
      };
  build: Effect.Success<ReturnType<typeof testFlightBuild>>;
};

const lower = (email: string) => email.trim().toLowerCase();
const now = () => new Date().toISOString();

const config = Effect.suspend(() => {
  const testFlight = testFlightConfig();
  return testFlight
    ? Effect.succeed(testFlight)
    : Effect.fail(new AppleError({ message: "TestFlight is off on this Nap" }));
});

// ---- App Store Connect ----

type User = { id: string; attributes: { username: string; allAppsVisible?: boolean } };
type Tester = {
  id: string;
  attributes: {
    email: string;
    state?: "NOT_INVITED" | "INVITED" | "ACCEPTED" | "INSTALLED" | "REVOKED";
  };
};

const findUser = Effect.fnUntraced(function* (appleEmail: string) {
  const users = yield* appStoreConnect<{ data: Array<User> }>(
    `users?filter[username]=${encodeURIComponent(appleEmail)}&fields[users]=username,allAppsVisible&limit=5`,
  );
  return users.data.find((user) => lower(user.attributes.username) === appleEmail) ?? null;
});

const hasInvitation = Effect.fnUntraced(function* (appleEmail: string) {
  const invitations = yield* appStoreConnect<{ data: Array<{ attributes: { email: string } }> }>(
    `userInvitations?filter[email]=${encodeURIComponent(appleEmail)}&fields[userInvitations]=email&limit=5`,
  );
  return invitations.data.some((invitation) => lower(invitation.attributes.email) === appleEmail);
});

const findTester = Effect.fnUntraced(function* (appleEmail: string) {
  const { appStoreId } = yield* config;
  const testers = yield* appStoreConnect<{ data: Array<Tester> }>(
    `betaTesters?filter[email]=${encodeURIComponent(appleEmail)}&filter[apps]=${appStoreId}&fields[betaTesters]=email,state&limit=5`,
  );
  return testers.data.find((tester) => lower(tester.attributes.email) === appleEmail) ?? null;
});

let internalGroup: string | null = null;

/** The app's internal TestFlight group: the one named Nap if there are several. */
const findInternalGroup = Effect.fnUntraced(function* () {
  if (internalGroup) return internalGroup;
  const { appStoreId } = yield* config;
  const groups = yield* appStoreConnect<{
    data: Array<{ id: string; attributes: { name: string; isInternalGroup: boolean } }>;
  }>(`apps/${appStoreId}/betaGroups?fields[betaGroups]=name,isInternalGroup&limit=50`);
  const internal = groups.data.filter((group) => group.attributes.isInternalGroup);
  const group = internal.find((each) => each.attributes.name === "Nap") ?? internal[0];
  if (!group) {
    return yield* new AppleError({
      message: "The app has no internal TestFlight group. Create one in App Store Connect.",
    });
  }
  internalGroup = group.id;
  return group.id;
});

function splitName(name: string, email: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? email.split("@")[0]!;
  return { firstName: first, lastName: parts.slice(1).join(" ") || first };
}

/** A user who can see the app, in the internal group. Apple then emails the TestFlight invite. */
const makeTester = Effect.fnUntraced(function* (user: User, identity: Identity) {
  const { appStoreId } = yield* config;
  if (user.attributes.allAppsVisible === false) {
    yield* appStoreConnect(`users/${user.id}/relationships/visibleApps`, {
      method: "POST",
      body: { data: [{ type: "apps", id: appStoreId }] },
    });
  }
  const appleEmail = lower(user.attributes.username);
  if (yield* findTester(appleEmail)) return;
  const group = yield* findInternalGroup();
  yield* appStoreConnect("betaTesters", {
    method: "POST",
    body: {
      data: {
        type: "betaTesters",
        attributes: { email: appleEmail, ...splitName(identity.name, appleEmail) },
        relationships: { betaGroups: { data: [{ type: "betaGroups", id: group }] } },
      },
    },
  });
});

// ---- Nap ----

const getRow = Effect.fnUntraced(function* (email: string) {
  const db = yield* Database;
  return yield* db.first<TesterRow>(
    `SELECT email, apple_email AS appleEmail, state FROM testflight_testers WHERE email = ?`,
    lower(email),
  );
});

const saveRow = Effect.fnUntraced(function* (
  email: string,
  appleEmail: string,
  state: TesterRow["state"],
) {
  const db = yield* Database;
  const at = now();
  yield* db.run(
    `INSERT INTO testflight_testers (email, apple_email, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET apple_email = excluded.apple_email,
       state = excluded.state, updated_at = excluded.updated_at`,
    lower(email),
    appleEmail,
    state,
    at,
    at,
  );
});

const TESTER_STATE = { INVITED: "invited", ACCEPTED: "accepted", INSTALLED: "installed" } as const;

/**
 * Where the caller is. Asks Apple whether a team invite was accepted (and then adds them to the
 * group), and how far a tester got. Someone who never asked but is already a tester under their
 * Nap email counts as a tester.
 */
export const installStatus = Effect.fn("installStatus")(function* (identity: Identity) {
  const testFlight = yield* config;
  const build = yield* testFlightBuild();
  const base = {
    enabled: true as const,
    url: testFlightUrl(testFlight.appStoreId),
    webUrl: `https://beta.itunes.apple.com/v1/app/${testFlight.appStoreId}`,
    napEmail: lower(identity.email),
    build,
  };
  let row = yield* getRow(identity.email);

  if (row?.state === "team_invited") {
    const user = yield* findUser(row.appleEmail);
    if (!user) {
      const pending = yield* hasInvitation(row.appleEmail);
      return {
        ...base,
        appleEmail: row.appleEmail,
        step: { kind: "team_invited" as const, pending },
      } satisfies InstallStatus;
    }
    yield* makeTester(user, identity);
    yield* saveRow(identity.email, row.appleEmail, "tester");
    row = { ...row, state: "tester" };
  }

  const appleEmail = row?.appleEmail ?? lower(identity.email);
  const tester = yield* findTester(appleEmail);
  if (!row && tester) yield* saveRow(identity.email, appleEmail, "tester");
  if (!row && !tester) {
    return { ...base, appleEmail: null, step: { kind: "new" as const } } satisfies InstallStatus;
  }
  const state = tester?.attributes.state;
  return {
    ...base,
    appleEmail,
    step: {
      kind: "tester" as const,
      tester:
        state && state in TESTER_STATE ? TESTER_STATE[state as keyof typeof TESTER_STATE] : null,
    },
  } satisfies InstallStatus;
});

/**
 * Asks Apple to invite the caller. An App Store Connect user goes straight into the TestFlight
 * group; anyone else is invited to the team first.
 */
export const requestInvite = Effect.fn("requestInvite")(function* (
  identity: Identity,
  email: string,
) {
  const { appStoreId } = yield* config;
  const appleEmail = lower(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(appleEmail)) {
    return yield* new AppleError({ message: "That doesn't look like an email address" });
  }
  const user = yield* findUser(appleEmail);
  if (user) {
    yield* makeTester(user, identity);
    yield* saveRow(identity.email, appleEmail, "tester");
  } else {
    if (!(yield* hasInvitation(appleEmail))) {
      yield* appStoreConnect("userInvitations", {
        method: "POST",
        body: {
          data: {
            type: "userInvitations",
            attributes: {
              email: appleEmail,
              ...splitName(identity.name, appleEmail),
              roles: [TESTER_ROLE],
              allAppsVisible: false,
              provisioningAllowed: false,
            },
            relationships: { visibleApps: { data: [{ type: "apps", id: appStoreId }] } },
          },
        },
      });
    }
    yield* saveRow(identity.email, appleEmail, "team_invited");
  }
  yield* Effect.logInfo("TestFlight invite requested").pipe(
    Effect.annotateLogs({ email: identity.email, appleEmail, member: Boolean(user) }),
  );
  return yield* installStatus(identity);
});

/** Starts over, to use another Apple Account email. */
export const forgetInvite = Effect.fn("forgetInvite")(function* (identity: Identity) {
  const db = yield* Database;
  yield* db.run(`DELETE FROM testflight_testers WHERE email = ?`, lower(identity.email));
  return yield* installStatus(identity);
});
