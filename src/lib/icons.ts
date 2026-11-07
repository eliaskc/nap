/**
 * The URL of one of the dashboard's icons (public/, or the instance's instance/icon/web), with the
 * icons' version: browsers keep a favicon under its URL, so a changed icon needs a new one.
 */
export function iconUrl(name: string) {
  return `/${name}?v=${__NAP_ICON_VERSION__}`;
}
