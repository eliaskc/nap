-- Who asked for the TestFlight app from the dashboard. Internal testers must be App Store Connect
-- users, so Nap first invites the person's Apple Account email to the team (team_invited), and
-- adds them to the app's internal group once they have accepted (tester). email is the Nap
-- sign-in; apple_email is where Apple sends its invites, which can be a different address.
CREATE TABLE testflight_testers (
  email TEXT PRIMARY KEY,
  apple_email TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('team_invited', 'tester')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
