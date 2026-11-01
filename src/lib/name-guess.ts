// Best-guess display name from an email (and optionally a name from the identity provider).
// Score 0–100; >= 60 counts as "we think it's pretty good".
import { FAMILY, GIVEN, fold, looksLikeSurname } from "./name-list.ts";

const GENERIC = new Set(["gmail.com", "googlemail.com", "hotmail.com", "hotmail.se", "outlook.com", "icloud.com", "yahoo.com", "yahoo.fr", "proton.me", "protonmail.com", "live.se", "me.com", "orange.fr", "free.fr", "laposte.net", "telia.com", "bredband.net"]);
const ROLE = new Set(["admin", "info", "hello", "hej", "contact", "team", "support", "dev", "office", "noreply", "bonjour", "kontakt"]);

export type Guess = { guess: string; score: number; confident: boolean; reasons: string[] };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const hasVowel = (s: string) => /[aeiouy]/i.test(s);
const given = (t: string) => GIVEN.get(t);
const family = (t: string) => FAMILY.get(t) ?? cap(t);
const pretty = (t: string, i: number) => (t.length === 1 ? t.toUpperCase() + "." : i === 0 ? given(t) ?? cap(t) : family(t));

export function guessName(email: string, idpName?: string | null): Guess {
  const reasons: string[] = [];
  if (idpName && idpName.trim().split(/\s+/).length >= 2) {
    return { guess: idpName.trim(), score: 92, confident: true, reasons: ["Sign-in provider sent a full name"] };
  }
  const [rawLocal = "", domain = ""] = email.trim().toLowerCase().split("@");
  const local = fold(rawLocal.split("+")[0]);
  let score = 50;

  if (GENERIC.has(domain)) {
    score -= 10;
    reasons.push("Personal mailbox: people pick odd handles");
  } else if (domain.includes(".")) {
    score += 10;
    reasons.push("Work-ish domain: usually firstname.lastname");
  }
  if (/\d/.test(local)) {
    score -= 20;
    reasons.push("Digits in the address");
  }

  const tokens = local.replace(/\d+/g, "").split(/[._-]+/).filter(Boolean);
  if (tokens.length === 0 || ROLE.has(tokens[0])) {
    return { guess: tokens[0] ? cap(tokens[0]) : "", score: 5, confident: false, reasons: [...reasons, "Looks like a role address"] };
  }

  if (tokens.length >= 2) {
    // Drop trailing initials-like noise only when a real first name leads.
    if (tokens.every((t) => t.length <= 2)) {
      score -= 30;
      reasons.push("Only initials");
    } else score += 10;
    if (given(tokens[0])) {
      score += 20;
      reasons.push(`“${given(tokens[0])}” is a known first name`);
    } else if (tokens[0].length > 2) {
      score -= 10;
      reasons.push(`“${cap(tokens[0])}” isn't a first name we know`);
    }
    const last = tokens[tokens.length - 1];
    if (last.length > 2 && looksLikeSurname(last)) {
      score += 10;
      reasons.push(`“${family(last)}” looks like a surname`);
    }
    if (tokens.some((t) => !hasVowel(t) && t.length > 2)) {
      score -= 15;
      reasons.push("A part has no vowels");
    }
    return finish(tokens.map(pretty).join(" "), score, reasons);
  }

  // One token: a first name, a first name glued to a surname, or a handle.
  const t = tokens[0];
  if (given(t)) {
    score += 25;
    reasons.push(`“${given(t)}” is a known first name`);
    return finish(given(t)!, score, reasons);
  }
  let best: { first: string; rest: string } | null = null;
  for (let i = t.length - 2; i >= 2; i--) {
    const first = t.slice(0, i);
    if (given(first)) {
      best = { first, rest: t.slice(i) };
      break;
    }
  }
  if (best && best.rest.length >= 3 && looksLikeSurname(best.rest)) {
    score += 15;
    reasons.push(`Reads as “${given(best.first)}” + “${family(best.rest)}”`);
    return finish(`${given(best.first)} ${family(best.rest)}`, score, reasons);
  }
  if (best) {
    score -= 5;
    reasons.push(`Starts with “${given(best.first)}”; the “${best.rest}” bit is a mystery`);
    return finish(given(best.first)!, score, reasons);
  }
  score -= 25;
  reasons.push("One word we don't recognise as a name");
  if (!hasVowel(t) || t.length <= 3) {
    score -= 15;
    reasons.push("Too short or no vowels");
  }
  return finish(cap(t), score, reasons);
}

function finish(guess: string, score: number, reasons: string[]): Guess {
  const s = Math.max(0, Math.min(100, score));
  return { guess, score: s, confident: s >= 60, reasons };
}
