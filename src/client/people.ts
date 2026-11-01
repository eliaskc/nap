import type { NapAvatarOptions, NapLooks, NapPerson } from "./api";
import { COLOR_VALUES, COLORS, SHAPE_PATHS, SHAPES, avatarSvg, isColor, isShape } from "../lib/looks";
import { napJson } from "./paths";

/** Everyone on Nap, or only these emails, with their names and looks. */
export async function people(emails?: Array<string>) {
  const query = emails?.length ? "?emails=" + encodeURIComponent(emails.join(",")) : "";
  const result = await napJson<{ people: Array<NapPerson> }>("people" + query);
  return result.people;
}

/** What Nap's shapes and colours look like, for pages that draw people themselves. */
export const looks: NapLooks = Object.freeze({
  shapes: SHAPES.slice(),
  colors: COLORS.slice(),
  shapePaths: Object.fromEntries(SHAPES.map((shape) => [shape, SHAPE_PATHS[shape].d])),
  colorValues: { ...COLOR_VALUES },
}) as NapLooks;

/** A person's avatar as an <svg> element: their shape, their colour, their initials. */
export function avatar(person: Pick<NapPerson, "name" | "shape" | "color">, options: NapAvatarOptions = {}) {
  const shape = isShape(person.shape) ? person.shape : "circle";
  const color = isColor(person.color) ? person.color : "blue";
  const template = document.createElement("template");
  template.innerHTML = avatarSvg({ shape, color }, person.name || "", options.size ?? 32, options.initials !== false);
  return template.content.firstElementChild as SVGSVGElement;
}

/**
 * <nap-avatar shape="clover" color="green" name="Anna Lindqvist" size="32">: the same avatar as
 * an element, for plain HTML. It redraws when an attribute changes.
 */
export function defineAvatarElement() {
  if (typeof customElements === "undefined" || customElements.get("nap-avatar")) return;
  customElements.define(
    "nap-avatar",
    class extends HTMLElement {
      static observedAttributes = ["shape", "color", "name", "size", "initials"];
      connectedCallback() {
        this.render();
      }
      attributeChangedCallback() {
        if (this.isConnected) this.render();
      }
      render() {
        const size = Number(this.getAttribute("size")) || 32;
        this.style.display = "inline-block";
        this.style.lineHeight = "0";
        this.replaceChildren(
          avatar(
            {
              name: this.getAttribute("name") ?? "",
              shape: (this.getAttribute("shape") ?? "") as NapPerson["shape"],
              color: (this.getAttribute("color") ?? "") as NapPerson["color"],
            },
            { size, initials: this.getAttribute("initials") !== "false" },
          ),
        );
      }
    },
  );
}
