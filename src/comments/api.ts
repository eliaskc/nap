export type Message = {
  id: string;
  body: string;
  author: { email: string; name: string };
  client: string | null;
  createdAt: string;
};

export type Thread = Message & {
  path: string;
  version: string | null;
  quote: string;
  prefix: string;
  suffix: string;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  replies: Array<Message>;
};

/** The comments API on this artifact's host (src/lib/comments.ts). */
export function commentsApi(base: string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(data.error || "Something went wrong. Try again.");
    return data;
  }
  type One = { comment: Thread };
  return {
    list: () => call<{ comments: Array<Thread> }>("GET", "").then((data) => data.comments),
    create: (input: {
      body: string;
      path: string;
      quote: string;
      prefix: string;
      suffix: string;
    }) => call<One>("POST", "", input).then((data) => data.comment),
    reply: (id: string, body: string) =>
      call<One>("POST", `/${id}/replies`, { body }).then((data) => data.comment),
    resolve: (id: string, resolved: boolean) =>
      call<One>("PATCH", `/${id}`, { resolved }).then((data) => data.comment),
  };
}
