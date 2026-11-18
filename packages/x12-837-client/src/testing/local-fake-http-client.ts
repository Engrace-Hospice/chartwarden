/** A response fixture built only from inert, caller-supplied bytes and metadata. */
export type LocalFakeHttpResponse = {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: RequestInit["headers"];
  readonly body?: string | Uint8Array | null;
  /** Fixed chunks are emitted by a local ReadableStream; no caller-provided stream/pull callback is accepted. */
  readonly chunks?: readonly Uint8Array[];
};

/**
 * A test-only HTTP seam. It constructs responses from inert local fixtures and has no code path to global fetch or a
 * caller-provided stream/socket. Requests are retained in memory for assertions only; values must remain synthetic.
 */
const localFakeClients = new WeakSet<object>();

export class LocalFakeHttpClient {
  readonly #requests: Array<{
    readonly url: string;
    readonly method: string;
    readonly redirect: RequestInit["redirect"];
    readonly headers: Headers;
    readonly body: RequestInit["body"];
  }> = [];

  readonly #responses: LocalFakeHttpResponse[];
  #nextResponse = 0;

  get requests(): readonly {
    readonly url: string;
    readonly method: string;
    readonly redirect: RequestInit["redirect"];
    readonly headers: Headers;
    readonly body: RequestInit["body"];
  }[] {
    return this.#requests;
  }

  constructor(responses: readonly LocalFakeHttpResponse[]) {
    this.#responses = responses.map((response) => ({
      ...response,
      headers: response.headers ? new Headers(response.headers) : undefined,
      body: response.body instanceof Uint8Array ? response.body.slice() : response.body,
      chunks: response.chunks?.map((chunk) => chunk.slice()),
    }));
    localFakeClients.add(this);
    Object.freeze(this);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    this.#requests.push({
      url: input instanceof URL ? input.toString() : String(input),
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    const response = this.#responses[this.#nextResponse];
    this.#nextResponse += 1;
    if (!response) throw new Error("LocalFakeHttpClient has no scripted response");
    if (response.body !== undefined && response.chunks !== undefined) {
      throw new Error("LocalFakeHttpClient response cannot define both body and chunks");
    }
    const responseInit: ResponseInit = {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    };
    if (response.chunks) {
      let nextChunk = 0;
      const chunks = response.chunks;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[nextChunk];
          nextChunk += 1;
          if (chunk) controller.enqueue(chunk.slice());
          else controller.close();
        },
      });
      return new Response(body, responseInit);
    }
    return new Response(response.body ?? null, responseInit);
  };
}

Object.freeze(LocalFakeHttpClient.prototype);

export function isLocalFakeHttpClient(value: unknown): value is LocalFakeHttpClient {
  return (
    typeof value === "object" &&
    value !== null &&
    localFakeClients.has(value) &&
    Object.getPrototypeOf(value) === LocalFakeHttpClient.prototype
  );
}
