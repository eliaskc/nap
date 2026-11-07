import * as React from "react";
import type { Color, Shape } from "~/lib/looks";
import { browserPlace, napLabel, napUrl } from "~/lib/nap-urls";
import { napConfig } from "~/nap.config";

/** What the dashboard lists. Apps are their own records; sites and artifacts share one table. */
export type Kind = "site" | "artifact" | "app";

export type Site = {
  slug: string;
  kind: "site" | "artifact";
  /** The source is in a Nap source repo. New versions come from agents, not uploads. */
  hasSource: boolean;
  title: string;
  createdByEmail: string;
  updatedByEmail: string;
  currentVersion: string;
  updatedAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  authorDisplayName: string | null;
  authorUsername: string | null;
  visibility: "everyone" | "private" | "selected";
  viewerEmails: Array<string>;
  listed: boolean;
  toolbar: boolean;
  invited: boolean;
  /** When you last opened it. Other people's artifacts are listed only once you have. */
  visitedAt: string | null;
};

export type App = {
  slug: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type Profile = {
  email: string;
  displayName: string | null;
  username: string | null;
  avatarColor: string | null;
  shape?: Shape;
  color?: Color;
};

/** One thing on the dashboard: a site, an artifact, or an app. */
export type Item = {
  key: string;
  kind: Kind;
  slug: string;
  title: string;
  /** Where it opens. */
  url: string;
  /** The URL as people read it: `slug.root` or `root/artifact/id`. */
  label: string;
  ownerEmail: string;
  ownerName: string;
  mine: boolean;
  views: number;
  updatedAt: string;
  visitedAt: string | null;
  site?: Site;
  app?: App;
};

export const KINDS: Array<Kind> = ["site", "artifact", "app"];

export const KIND_LABEL: Record<Kind, { one: string; many: string }> = {
  site: { one: "Site", many: "Sites" },
  artifact: { one: "Artifact", many: "Artifacts" },
  app: { one: "App", many: "Apps" },
};

const SITES_POLL_MS = 4_000;
const APPS_POLL_MS = 30_000;

/** Your profile, everything you can see, and a refresh. Polls, like the rest of Nap. */
export function useDashboardData() {
  const [sites, setSites] = React.useState<Array<Site>>([]);
  const [apps, setApps] = React.useState<Array<App>>([]);
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async (quiet = false) => {
    try {
      const [meRes, sitesRes] = await Promise.all([fetch("/api/me"), fetch("/api/sites")]);
      if (!meRes.ok || !sitesRes.ok) throw new Error("Failed to load data");
      const meJson = (await meRes.json()) as { profile: Profile };
      const sitesJson = (await sitesRes.json()) as { sites: Array<Site> };
      setProfile(meJson.profile);
      setSites(sitesJson.sites);
    } catch (error) {
      if (!quiet) console.error(error);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshApps = React.useCallback(async () => {
    if (!napConfig.apps) return;
    try {
      const response = await fetch("/api/apps");
      if (!response.ok) return;
      const body = (await response.json()) as { apps: Array<App> };
      setApps(body.apps);
    } catch {
      // Apps are extra. The dashboard works without them.
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    void refreshApps();
    const sitesTimer = window.setInterval(() => void refresh(true), SITES_POLL_MS);
    const appsTimer = window.setInterval(() => void refreshApps(), APPS_POLL_MS);
    return () => {
      window.clearInterval(sitesTimer);
      window.clearInterval(appsTimer);
    };
  }, [refresh, refreshApps]);

  const myEmail = profile?.email.toLowerCase() ?? null;
  const items = React.useMemo(() => {
    const root = napConfig.rootDomain;
    const place = typeof window === "undefined" ? undefined : browserPlace(root);
    const fromSites = sites.map(
      (site): Item => ({
        key: `${site.kind}:${site.slug}`,
        kind: site.kind,
        slug: site.slug,
        title: site.title,
        url: place ? napUrl(site, place) : "#",
        label: napLabel(site, root),
        ownerEmail: site.createdByEmail,
        ownerName: site.authorDisplayName ?? site.createdByEmail,
        mine: myEmail !== null && site.createdByEmail.toLowerCase() === myEmail,
        views: site.viewCount,
        updatedAt: site.updatedAt,
        visitedAt: site.visitedAt,
        site,
      }),
    );
    const fromApps = apps.map(
      (app): Item => ({
        key: `app:${app.slug}`,
        kind: "app",
        slug: app.slug,
        title: app.title,
        url: "/app",
        label: `${root}/app`,
        ownerEmail: app.createdBy,
        ownerName: app.createdBy.split("@")[0] ?? app.createdBy,
        mine: myEmail !== null && app.createdBy.toLowerCase() === myEmail,
        views: 0,
        updatedAt: app.updatedAt,
        visitedAt: null,
        app,
      }),
    );
    return [...fromSites, ...fromApps];
  }, [sites, apps, myEmail]);

  return { sites, setSites, items, profile, loading, refresh };
}

export type Filter = "all" | "mine" | "shared";
export type Sort = "popular" | "updated" | "visited" | "name";
export type Look = "list" | "cards";

export const FILTERS: Array<{ value: Filter; label: string; empty: string }> = [
  { value: "all", label: "All", empty: "Nothing here yet. Copy the prompt and ask your agent." },
  { value: "mine", label: "Mine", empty: "You haven't published anything yet." },
  { value: "shared", label: "Shared with me", empty: "Nobody has shared anything with you yet." },
];

export const SORTS: Array<{ value: Sort; label: string }> = [
  { value: "popular", label: "Most popular" },
  { value: "updated", label: "Recently updated" },
  { value: "visited", label: "Recently visited" },
  { value: "name", label: "Name" },
];

/** A setting kept in this browser. Reads it after the first render, so SSR and the client agree. */
export function useStored<T>(key: string, fallback: T, valid: (value: unknown) => boolean) {
  const [value, setValue] = React.useState<T>(fallback);
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (valid(parsed)) setValue(parsed as T);
    } catch {
      // A broken value falls back to the default.
    }
    // `valid` is a pure check; reading once is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = React.useCallback(
    (next: T) => {
      setValue(next);
      window.localStorage.setItem(key, JSON.stringify(next));
    },
    [key],
  );
  return [value, set] as const;
}

const oneOf =
  <T extends string>(values: ReadonlyArray<T>) =>
  (value: unknown) =>
    typeof value === "string" && (values as ReadonlyArray<string>).includes(value);

/** The filter, sort, kinds, and look, kept in this browser, and the items they show. */
export function useItemView(items: Array<Item>) {
  const [filter, setFilter] = useStored<Filter>(
    "nap:filter",
    "all",
    oneOf(["all", "mine", "shared"]),
  );
  const [sort, setSort] = useStored<Sort>(
    "nap:sort",
    "popular",
    oneOf(["popular", "updated", "visited", "name"]),
  );
  const [look, setLook] = useStored<Look>("nap:look", "list", oneOf(["list", "cards"]));
  const [kinds, setKinds] = useStored<Array<Kind>>(
    "nap:kinds",
    KINDS,
    (value) => Array.isArray(value) && value.every((kind) => KINDS.includes(kind as Kind)),
  );

  const visible = React.useMemo(() => {
    const shown = items.filter(
      (item) =>
        kinds.includes(item.kind) &&
        (filter === "all" || (filter === "mine" ? item.mine : !item.mine)),
    );
    const byUpdated = (a: Item, b: Item) => b.updatedAt.localeCompare(a.updatedAt);
    const compare: Record<Sort, (a: Item, b: Item) => number> = {
      popular: (a, b) => b.views - a.views || byUpdated(a, b),
      updated: byUpdated,
      visited: (a, b) => (b.visitedAt ?? "").localeCompare(a.visitedAt ?? "") || byUpdated(a, b),
      name: (a, b) => a.title.localeCompare(b.title),
    };
    return shown.sort(compare[sort]);
  }, [items, filter, sort, kinds]);

  const counts = React.useMemo(
    () => ({
      all: items.length,
      mine: items.filter((item) => item.mine).length,
      shared: items.filter((item) => !item.mine).length,
    }),
    [items],
  );

  return { filter, setFilter, sort, setSort, look, setLook, kinds, setKinds, visible, counts };
}

export type ItemView = ReturnType<typeof useItemView>;
