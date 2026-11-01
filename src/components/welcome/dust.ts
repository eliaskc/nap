/**
 * The welcome transition. The page crumbles into particles of itself, starting where the person
 * tapped. On a dark screen the dust burns white-hot; on a light one it chars to ink. Both cool
 * into the person's colour and drift off, and some of it comes back as the card: their shape and
 * "Hi, <name>". When it resolves, the screen shows exactly the card, so the page can swap it for
 * the DOM card and navigate.
 */
import { COLOR_VALUES, firstName, initials, type Look } from "~/lib/looks";
import { drawShape } from "./capture";

export const CARD = { shape: 124, shapeY: 0.42, nameGap: 104, nameSize: 34, subGap: 142, subSize: 13 };
export const DUST_SECONDS = 2.5;

export type CardTheme = { bg: string; fg: string; sub: string };
export const cardTheme = (dark: boolean): CardTheme =>
  dark
    ? { bg: "#000000", fg: "#ffffff", sub: "rgba(255,255,255,.5)" }
    : { bg: "#ffffff", fg: "#0b0b0d", sub: "rgba(11,11,13,.5)" };

export function drawCard(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  person: { name: string } & Look,
  theme: CardTheme,
  subtitle: string,
  font: string,
) {
  const cy = height * CARD.shapeY;
  drawShape(ctx, person.shape, COLOR_VALUES[person.color], initials(person.name), width / 2, cy, CARD.shape, "#fff", font);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.fg;
  ctx.font = `800 ${CARD.nameSize}px ${font}`;
  if ("letterSpacing" in ctx) (ctx as { letterSpacing: string }).letterSpacing = "-0.8px";
  ctx.fillText(`Hi, ${firstName(person.name)}`, width / 2, cy + CARD.nameGap);
  if ("letterSpacing" in ctx) (ctx as { letterSpacing: string }).letterSpacing = "0px";
  ctx.fillStyle = theme.sub;
  ctx.font = `500 ${CARD.subSize}px ${font}`;
  ctx.fillText(subtitle, width / 2, cy + CARD.subGap);
}

const VS = (dark: boolean) => `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uGrid, uSize, uOrigin;
uniform vec3 uTint;
uniform float uT, uDpr, uSpacing, uMaxD;
in vec2 aTarget;
in vec4 aTColor;
in float aHas;
out vec4 vCol;
out float vRound;
float hash(float n){ return fract(sin(n*12.9898)*43758.5453); }
float sm(float a, float b, float x){ return smoothstep(a, b, x); }
void main(){
  float id = float(gl_VertexID);
  vec2 start = (vec2(mod(id, uGrid.x), floor(id / uGrid.x)) + .5) * uSpacing;
  vec4 tc = texture(uTex, vec2(start.x/uSize.x, 1. - start.y/uSize.y));
  float r1 = hash(id), r2 = hash(id + 7.7), r3 = hash(id + 3.1);
  float d = length(start - uOrigin) / uMaxD;
  float delay = d*0.95 + r1*0.22 + sin(start.y*0.05 + start.x*0.03)*0.05;
  float L = clamp((uT - delay)/1.0, 0., 1.);
  float e = L*L;
  vec2 dir = normalize(start - uOrigin + vec2(0.001));
  vec2 wind = vec2(70., -160.) + dir*90. + vec2(r2 - .5, r3 - .5)*120.;
  vec2 swirl = vec2(sin(L*6. + r1*30.), cos(L*5. + r2*30.)) * 22. * L;
  vec2 pos = start + wind*e + swirl;
  vec3 ember = ${
    dark
      ? "mix(vec3(1., .97, .92), mix(uTint*0.9, uTint*1.4 + 0.1, r3), sm(0.12, 0.55, L))"
      : "mix(vec3(0.07, 0.07, 0.08), mix(uTint*0.75, min(uTint*1.25 + 0.05, vec3(1.)), r3), sm(0.12, 0.55, L))"
  };
  vec3 col = mix(tc.rgb, ember, sm(0.02, 0.25, L));
  float a = 1. - sm(0.25, 0.95, L);
  float size = uSpacing * mix(1.0, 0.55 + r1*0.6, sm(0., .15, L));
  float R = clamp((uT - 1.4 - r2*0.45 - (1. - aTarget.y/uSize.y)*0.15)/0.75, 0., 1.);
  R = aHas * (R < .5 ? 4.*R*R*R : 1. - pow(-2.*R + 2., 3.)/2.);
  pos = mix(pos, aTarget, R);
  col = mix(col, aTColor.rgb, R);
  a = mix(a, aTColor.a, R);
  size = mix(size, uSpacing, R);
  vCol = vec4(col * a, a);
  vRound = sm(0.02, 0.1, L) * (1. - R);
  gl_PointSize = size * uDpr + 0.6;
  vec2 clip = pos / uSize * 2. - 1.;
  gl_Position = vec4(clip.x, -clip.y, 0., 1.);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vCol; in float vRound; out vec4 o;
void main(){ o = vCol * mix(1., smoothstep(.5, .2, length(gl_PointCoord - .5)), vRound); }`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
  return program;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** True when this browser can run the transition. */
export function canRunDust() {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

/**
 * Plays the transition in `canvas` (sized to `width` × `height` CSS px) and resolves when the
 * card has formed. The last frame stays on screen.
 */
export function runDust(options: {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  dpr: number;
  page: HTMLCanvasElement;
  origin: { x: number; y: number };
  person: { name: string } & Look;
  dark: boolean;
  subtitle: string;
  font: string;
}): Promise<void> {
  const { canvas, width, height, dpr } = options;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false })!;
  const program = compile(gl, VS(options.dark), FS);
  gl.useProgram(program);

  // One particle per 1.5 px on a phone; coarser on big screens, so it stays around 250k.
  const spacing = Math.max(1.5, Math.sqrt((width * height) / 250_000));
  const gx = Math.ceil(width / spacing);
  const gy = Math.ceil(height / spacing);
  const count = gx * gy;
  const theme = cardTheme(options.dark);

  // Where the card's pixels are: some particles end there.
  const card = document.createElement("canvas");
  card.width = gx;
  card.height = gy;
  const cardCtx = card.getContext("2d", { willReadFrequently: true })!;
  cardCtx.scale(1 / spacing, 1 / spacing);
  drawCard(cardCtx, width, height, options.person, theme, options.subtitle, options.font);
  const pixels = cardCtx.getImageData(0, 0, gx, gy).data;
  const targets: Array<number> = [];
  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      const i = (y * gx + x) * 4;
      if (pixels[i + 3] > 40) {
        targets.push(x, y, pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255, pixels[i + 3] / 255);
      }
    }
  }
  const aTarget = new Float32Array(count * 2);
  const aTColor = new Float32Array(count * 4);
  const aHas = new Float32Array(count);
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let k = 0; k < Math.min(targets.length / 6, count); k++) {
    const i = order[k];
    aTarget[i * 2] = (targets[k * 6] + 0.5) * spacing;
    aTarget[i * 2 + 1] = (targets[k * 6 + 1] + 0.5) * spacing;
    aTColor.set(targets.slice(k * 6 + 2, k * 6 + 6), i * 4);
    aHas[i] = 1;
  }
  gl.bindVertexArray(gl.createVertexArray());
  for (const [name, data, size] of [
    ["aTarget", aTarget, 2],
    ["aTColor", aTColor, 4],
    ["aHas", aHas, 1],
  ] as const) {
    const location = gl.getAttribLocation(program, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  }

  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, options.page);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const uniform = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform1i(uniform("uTex"), 0);
  gl.uniform2f(uniform("uGrid"), gx, gy);
  gl.uniform2f(uniform("uSize"), width, height);
  gl.uniform2f(uniform("uOrigin"), options.origin.x, options.origin.y);
  gl.uniform3f(uniform("uTint"), ...hexToRgb(COLOR_VALUES[options.person.color]));
  gl.uniform1f(uniform("uDpr"), dpr);
  gl.uniform1f(uniform("uSpacing"), spacing);
  gl.uniform1f(uniform("uMaxD"), Math.hypot(width, height));
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const [br, bg, bb] = hexToRgb(theme.bg);

  return new Promise((resolve) => {
    let start = 0;
    const frame = (now: number) => {
      if (!start) start = now;
      const t = Math.min(DUST_SECONDS, (now - start) / 1000);
      gl.uniform1f(uniform("uT"), t);
      gl.clearColor(br, bg, bb, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, count);
      if (t < DUST_SECONDS) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}
