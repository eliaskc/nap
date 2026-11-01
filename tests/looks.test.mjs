import test from "node:test";
import assert from "node:assert/strict";
import { COLORS, SHAPES, firstFreeLook, lookKey, preferredLook } from "../src/lib/looks.ts";
import { guessName } from "../src/lib/name-guess.ts";

test("49 people get 49 different looks, starting from their preferred one", () => {
  const taken = new Set();
  const first = "anna@example.test";
  assert.deepEqual(firstFreeLook(first, taken), preferredLook(first));
  for (let i = 0; i < SHAPES.length * COLORS.length; i++) {
    const key = lookKey(firstFreeLook(`person${i}@example.test`, taken));
    assert.ok(!taken.has(key), `look ${key} given twice`);
    taken.add(key);
  }
  assert.equal(taken.size, 49);
});

test("the name guess is confident about clear names and humble about the rest", () => {
  const anna = guessName("anna.lindqvist@gmail.com");
  assert.equal(anna.guess, "Anna Lindqvist");
  assert.ok(anna.confident);
  assert.equal(guessName("x7k2@example.test").confident, false);
  assert.equal(guessName("someone@example.test", "Jean-Luc Picard").guess, "Jean-Luc Picard");
});
