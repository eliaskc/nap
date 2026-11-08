import { BellIcon, BellOffIcon } from "lucide-react";
import * as React from "react";
import { Spinner } from "~/components/ui/spinner";
import { GroupButton } from "~/dashboard/controls";
import { napConfig } from "~/nap.config";

/**
 * The bell in the bar: notifications in this browser (web push), on desktop. It asks the
 * browser for permission only when clicked. Phones get them through the app instead, so the bell
 * is not there on phones and tablets, nor on Naps without notifications.
 */

const ENABLED = napConfig.notifications === true;
const WORKER = "/push-sw.js";
/** The last known state in this browser, so the bell is right from the first paint. */
const CACHE_KEY = "nap:push-on";

type State = "off" | "on" | "busy" | "denied";

function supported() {
  if (typeof window === "undefined") return false;
  const mobile =
    /Android|iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return (
    !mobile && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
  );
}

function keyBytes(key: string) {
  const plain = key.replace(/-/g, "+").replace(/_/g, "/");
  const padded = plain + "=".repeat((4 - (plain.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration(WORKER);
  return (await registration?.pushManager.getSubscription()) ?? null;
}

async function send(method: "POST" | "DELETE", body: unknown) {
  const response = await fetch("/api/push", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "Could not change notifications");
  }
}

export function NotificationsButton() {
  const [shown, setShown] = React.useState(false);
  const [state, setState] = React.useState<State>("off");
  const [key, setKey] = React.useState("");

  React.useEffect(() => {
    if (!ENABLED || !supported()) return;
    setShown(true);
    if (localStorage.getItem(CACHE_KEY) === "1") setState("on");
    if (Notification.permission === "denied") setState("denied");
    let cancelled = false;
    void (async () => {
      const subscription = await currentSubscription().catch(() => null);
      const query = subscription ? `?endpoint=${encodeURIComponent(subscription.endpoint)}` : "";
      const response = await fetch(`/api/push${query}`).catch(() => null);
      if (!response?.ok || cancelled) return;
      const data = (await response.json()) as {
        enabled: boolean;
        vapidPublicKey?: string;
        on: boolean;
      };
      if (!data.enabled) return setShown(false);
      setKey(data.vapidPublicKey ?? "");
      // On here and known to Nap. A subscription Nap lost is sent again on the next click.
      const on = Boolean(subscription && data.on && Notification.permission === "granted");
      localStorage.setItem(CACHE_KEY, on ? "1" : "0");
      setState(Notification.permission === "denied" ? "denied" : on ? "on" : "off");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!shown) return null;

  const turnOn = async () => {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return setState(permission === "denied" ? "denied" : "off");
    const registration = await navigator.serviceWorker.register(WORKER);
    await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(key),
      }));
    // The first time, Nap sends one right away, so the person sees it works.
    await send("POST", { ...subscription.toJSON(), test: true });
    localStorage.setItem(CACHE_KEY, "1");
    setState("on");
  };

  const turnOff = async () => {
    const subscription = await currentSubscription();
    if (subscription) {
      await send("DELETE", { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    localStorage.setItem(CACHE_KEY, "0");
    setState("off");
  };

  const label =
    state === "on"
      ? "Notifications are on in this browser. Click to turn them off."
      : state === "denied"
        ? "This browser blocks notifications from Nap. Allow them in the site settings."
        : "Get notifications in this browser";

  return (
    <GroupButton
      icon
      aria-label={label}
      title={label}
      aria-pressed={state === "on"}
      disabled={state === "busy" || (state === "denied" && Notification.permission === "denied")}
      onClick={() => {
        const was = state;
        setState("busy");
        void (was === "on" ? turnOff() : turnOn()).catch((error) => {
          console.error(error);
          setState(was === "busy" ? "off" : was);
        });
      }}
    >
      {state === "busy" ? <Spinner /> : state === "on" ? <BellIcon /> : <BellOffIcon />}
    </GroupButton>
  );
}
