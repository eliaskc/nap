/**
 * Capabilities that prototypes declare in prototype.json ("capabilities": ["push-notifications"]).
 * The template merges them into the launcher's Info.plist as NapCapabilities, prototype by
 * prototype. When a TestFlight build asks for one, Nap turns it on for the app's App ID, makes a
 * new App Store profile, and signs with its entitlements. What Nap cannot turn on becomes a
 * warning: the signer writes it into the app as NapCapabilityWarnings, and the launcher shows it
 * on the prototype that asked.
 */

/** Capabilities Nap turns on by itself: switches on the App ID, with no setup of their own. */
export const AUTOMATIC_CAPABILITIES = {
  "push-notifications": {
    label: "Push notifications",
    apple: "PUSH_NOTIFICATIONS",
    entitlements: ["aps-environment"],
  },
  healthkit: {
    label: "HealthKit",
    apple: "HEALTHKIT",
    entitlements: ["com.apple.developer.healthkit", "com.apple.developer.healthkit.access"],
  },
  siri: { label: "Siri", apple: "SIRIKIT", entitlements: ["com.apple.developer.siri"] },
  "nfc-tag-reading": {
    label: "NFC tag reading",
    apple: "NFC_TAG_READING",
    entitlements: ["com.apple.developer.nfc.readersession.formats"],
  },
  "wifi-info": {
    label: "Wi-Fi information",
    apple: "ACCESS_WIFI_INFORMATION",
    entitlements: ["com.apple.developer.networking.wifi-info"],
  },
  homekit: { label: "HomeKit", apple: "HOMEKIT", entitlements: ["com.apple.developer.homekit"] },
  "game-center": {
    label: "Game Center",
    apple: "GAME_CENTER",
    entitlements: ["com.apple.developer.game-center"],
  },
} as const;

/** Capabilities that need setup Nap cannot do through Apple's API, and why. */
export const MANUAL_CAPABILITIES: Record<string, { label: string; reason: string }> = {
  "app-groups": {
    label: "App Groups",
    reason: "needs an App Group registered in the developer account first",
  },
  icloud: { label: "iCloud", reason: "needs an iCloud container registered first" },
  "associated-domains": {
    label: "Associated Domains",
    reason: "needs an apple-app-site-association file on the domain",
  },
  "sign-in-with-apple": {
    label: "Sign in with Apple",
    reason: "needs its settings in the developer account",
  },
  "apple-pay": { label: "Apple Pay", reason: "needs a merchant ID first" },
};

export type AutomaticCapability = keyof typeof AUTOMATIC_CAPABILITIES;

export const isAutomatic = (name: string): name is AutomaticCapability =>
  Object.hasOwn(AUTOMATIC_CAPABILITIES, name);

/** What a build asks for: prototype slug → capability names, from its Info.plist. */
export type CapabilityRequests = Record<string, Array<string>>;

/** What the launcher shows: prototype slug → one sentence per capability it cannot have. */
export type CapabilityWarnings = Record<string, Array<string>>;

export function labelOf(name: string) {
  if (isAutomatic(name)) return AUTOMATIC_CAPABILITIES[name].label;
  return MANUAL_CAPABILITIES[name]?.label ?? name;
}

/** Keeps well-formed requests only: the plist comes from the build. */
export function readRequests(value: unknown): CapabilityRequests {
  const requests: CapabilityRequests = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return requests;
  for (const [slug, names] of Object.entries(value)) {
    if (!/^[a-z0-9-]{1,64}$/.test(slug) || !Array.isArray(names)) continue;
    const valid = names.filter(
      (name): name is string => typeof name === "string" && /^[a-z0-9-]{1,64}$/.test(name),
    );
    if (valid.length) requests[slug] = [...new Set(valid)];
  }
  return requests;
}

/**
 * Splits a build's requests into what to turn on and what to warn about. `refuse` gives the
 * reason for a capability that could be automatic but is not available here (ad hoc builds, or
 * one Apple would not turn on); null means it is fine.
 */
export function planCapabilities(
  requests: CapabilityRequests,
  refuse: (name: AutomaticCapability) => string | null,
) {
  const granted = new Set<AutomaticCapability>();
  const warnings: CapabilityWarnings = {};
  for (const [slug, names] of Object.entries(requests)) {
    for (const name of names) {
      let reason: string | null;
      if (isAutomatic(name)) {
        reason = refuse(name);
        if (!reason) granted.add(name);
      } else {
        reason =
          MANUAL_CAPABILITIES[name]?.reason ?? "is not a capability Nap knows. Check the spelling";
      }
      if (reason) (warnings[slug] ??= []).push(`${labelOf(name)} ${reason}.`);
    }
  }
  const entitlementKeys = [...granted].flatMap((name) => AUTOMATIC_CAPABILITIES[name].entitlements);
  return { granted: [...granted], warnings, entitlementKeys };
}
