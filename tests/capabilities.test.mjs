import test from "node:test";
import assert from "node:assert/strict";
import { planCapabilities, readRequests } from "../src/lib/capabilities.ts";

test("readRequests keeps well-formed slugs and names, once each", () => {
  assert.deepEqual(
    readRequests({
      snore: ["healthkit", "healthkit", "push-notifications"],
      "Bad Slug": ["healthkit"],
      odd: "healthkit",
      mixed: ["siri", 4, "NOPE!"],
    }),
    { snore: ["healthkit", "push-notifications"], mixed: ["siri"] },
  );
  assert.deepEqual(readRequests(null), {});
  assert.deepEqual(readRequests(["healthkit"]), {});
});

test("planCapabilities grants what it can and warns per app about the rest", () => {
  const plan = planCapabilities(
    { snore: ["healthkit", "icloud"], ping: ["push-notifications", "teleport"] },
    (name) => (name === "push-notifications" ? "is not on this Nap's list" : null),
  );
  assert.deepEqual(plan.granted, ["healthkit"]);
  assert.deepEqual(plan.entitlementKeys, [
    "com.apple.developer.healthkit",
    "com.apple.developer.healthkit.access",
  ]);
  assert.deepEqual(plan.warnings, {
    snore: ["iCloud needs an iCloud container registered first."],
    ping: [
      "Push notifications is not on this Nap's list.",
      "teleport is not a capability Nap knows. Check the spelling.",
    ],
  });
});

test("a capability two apps ask for is granted once", () => {
  const plan = planCapabilities({ a: ["siri"], b: ["siri"] }, () => null);
  assert.deepEqual(plan.granted, ["siri"]);
  assert.deepEqual(plan.warnings, {});
});
