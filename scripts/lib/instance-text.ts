/** An instructions topic with what the instance adds to it (instance/instructions/<topic>.md). */
export function withInstanceText(text: string, added: string | undefined) {
  return added?.trim() ? `${text.trimEnd()}\n\n## On this Nap\n\n${added.trim()}\n` : text;
}
