/**
 * <nap-locked hint="You don't have access to revenue numbers. Ask Elias if you need them.">:
 * a small crossed-out eye for a part of the page that the viewer is not allowed to see, so it
 * reads as hidden on purpose and not as broken. Pages put it where the numbers would be, when a
 * call fails with a NapError that has `locked`.
 *
 * The first one on the page says the hint next to the eye. The others are only the eye, with the
 * hint as their tooltip, so a dashboard with many locked parts says it once.
 */
const EYE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1.15em" height="1.15em" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true" style="flex:none">' +
  '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>' +
  '<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>' +
  '<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>' +
  '<path d="m2 2 20 20"/></svg>';
const DEFAULT_HINT = "You don't have access to this.";

export function defineLockedElement() {
  if (typeof customElements === "undefined" || customElements.get("nap-locked")) return;
  customElements.define(
    "nap-locked",
    class extends HTMLElement {
      static observedAttributes = ["hint"];
      connectedCallback() {
        this.render();
      }
      attributeChangedCallback() {
        if (this.isConnected) this.render();
      }
      render() {
        const hint = this.getAttribute("hint") || DEFAULT_HINT;
        // The one that says the hint: this one already, or the first on the page.
        const speaker = document.querySelector("nap-locked[data-says-hint]");
        const says = !speaker || speaker === this;
        this.toggleAttribute("data-says-hint", says);
        this.setAttribute("role", "img");
        this.setAttribute("aria-label", hint);
        this.title = says ? "" : hint;
        Object.assign(this.style, {
          display: "inline-flex",
          alignItems: "center",
          gap: "0.45em",
          opacity: "0.55",
          fontSize: "0.8125rem",
          fontWeight: "400",
          lineHeight: "1.3",
          textAlign: "left",
        });
        this.innerHTML = EYE;
        if (says) {
          const text = document.createElement("span");
          text.textContent = hint;
          this.appendChild(text);
        }
      }
    },
  );
}
