import "server-only";

// The former generated SDK exposed schema-less rows throughout this codebase.
// Keep that compatibility boundary here while the repositories remain untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UntypedData = any;

type PostgrestError = {
  code: string | null;
  details: string | null;
  hint: string | null;
  message: string;
};

type PostgrestResponse<T> = {
  data: T | null;
  error: PostgrestError | null;
  count: number | null;
  status: number;
  statusText: string;
};

type SelectOptions = {
  count?: "exact" | "planned" | "estimated";
  head?: boolean;
};

type OrderOptions = {
  ascending?: boolean;
  nullsFirst?: boolean;
};

type UpsertOptions = {
  onConflict?: string;
  ignoreDuplicates?: boolean;
  count?: "exact" | "planned" | "estimated";
};

type QueryMode = "table" | "rpc";

function serializedValue(value: unknown) {
  if (value === null) return "null";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function quotedListValue(value: unknown) {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  const text = serializedValue(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  return `"${text}"`;
}

function normalizedError(payload: unknown, statusText: string): PostgrestError {
  if (payload && typeof payload === "object") {
    const row = payload as Record<string, unknown>;
    return {
      code: typeof row.code === "string" ? row.code : null,
      details: typeof row.details === "string" ? row.details : null,
      hint: typeof row.hint === "string" ? row.hint : null,
      message:
        typeof row.message === "string" && row.message
          ? row.message
          : statusText || "Data API request failed.",
    };
  }
  return {
    code: null,
    details: null,
    hint: null,
    message: statusText || "Data API request failed.",
  };
}

function appendPreference(headers: Headers, preference: string) {
  const current = headers.get("Prefer");
  headers.set("Prefer", current ? `${current},${preference}` : preference);
}

class PostgrestQueryBuilder<T> implements PromiseLike<PostgrestResponse<T>> {
  private readonly url: URL;
  private readonly headers: Headers;
  private method: "GET" | "HEAD" | "POST" | "PATCH" | "DELETE" = "GET";
  private body: unknown;
  private signal: AbortSignal | undefined;
  private maybeSingleResult = false;

  constructor(
    baseUrl: string,
    resource: string,
    private readonly mode: QueryMode,
    schema: string,
    defaultHeaders: HeadersInit,
    private readonly fetcher: typeof fetch,
  ) {
    this.url = new URL(
      `${baseUrl.replace(/\/+$/gu, "")}/${
        mode === "rpc" ? "rpc/" : ""
      }${encodeURIComponent(resource)}`,
    );
    this.headers = new Headers(defaultHeaders);
    this.headers.set("Accept-Profile", schema);
    this.headers.set("Content-Profile", schema);
  }

  select<Result = UntypedData[]>(columns = "*", options: SelectOptions = {}) {
    this.url.searchParams.set("select", columns.replace(/\s+/gu, ""));
    if (this.method !== "GET" && this.method !== "HEAD") {
      appendPreference(this.headers, "return=representation");
    }
    if (options.count) appendPreference(this.headers, `count=${options.count}`);
    if (options.head) this.method = "HEAD";
    return this as unknown as PostgrestQueryBuilder<Result>;
  }

  insert<Result = null>(values: unknown, options: { count?: SelectOptions["count"] } = {}) {
    this.method = "POST";
    this.body = values;
    if (options.count) appendPreference(this.headers, `count=${options.count}`);
    return this as unknown as PostgrestQueryBuilder<Result>;
  }

  upsert<Result = null>(values: unknown, options: UpsertOptions = {}) {
    this.method = "POST";
    this.body = values;
    if (options.onConflict) this.url.searchParams.set("on_conflict", options.onConflict);
    appendPreference(
      this.headers,
      options.ignoreDuplicates ? "resolution=ignore-duplicates" : "resolution=merge-duplicates",
    );
    if (options.count) appendPreference(this.headers, `count=${options.count}`);
    return this as unknown as PostgrestQueryBuilder<Result>;
  }

  update<Result = null>(values: unknown, options: { count?: SelectOptions["count"] } = {}) {
    this.method = "PATCH";
    this.body = values;
    if (options.count) appendPreference(this.headers, `count=${options.count}`);
    return this as unknown as PostgrestQueryBuilder<Result>;
  }

  delete<Result = null>(options: { count?: SelectOptions["count"] } = {}) {
    this.method = "DELETE";
    if (options.count) appendPreference(this.headers, `count=${options.count}`);
    return this as unknown as PostgrestQueryBuilder<Result>;
  }

  eq(column: string, value: unknown) {
    return this.filter(column, "eq", value);
  }

  neq(column: string, value: unknown) {
    return this.filter(column, "neq", value);
  }

  gt(column: string, value: unknown) {
    return this.filter(column, "gt", value);
  }

  gte(column: string, value: unknown) {
    return this.filter(column, "gte", value);
  }

  lt(column: string, value: unknown) {
    return this.filter(column, "lt", value);
  }

  lte(column: string, value: unknown) {
    return this.filter(column, "lte", value);
  }

  ilike(column: string, pattern: string) {
    return this.filter(column, "ilike", pattern);
  }

  is(column: string, value: boolean | null) {
    return this.filter(column, "is", value);
  }

  in(column: string, values: readonly unknown[]) {
    this.url.searchParams.append(
      column,
      `in.(${values.map(quotedListValue).join(",")})`,
    );
    return this;
  }

  or(filters: string, options: { foreignTable?: string } = {}) {
    const key = options.foreignTable ? `${options.foreignTable}.or` : "or";
    this.url.searchParams.append(key, `(${filters})`);
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    this.url.searchParams.append(
      column,
      `not.${operator}.${serializedValue(value)}`,
    );
    return this;
  }

  filter(column: string, operator: string, value: unknown) {
    this.url.searchParams.append(
      column,
      `${operator}.${serializedValue(value)}`,
    );
    return this;
  }

  order(column: string, options: OrderOptions = {}) {
    const direction = options.ascending === false ? "desc" : "asc";
    const nulls = options.nullsFirst === undefined
      ? ""
      : options.nullsFirst
        ? ".nullsfirst"
        : ".nullslast";
    const next = `${column}.${direction}${nulls}`;
    const current = this.url.searchParams.get("order");
    this.url.searchParams.set("order", current ? `${current},${next}` : next);
    return this;
  }

  limit(count: number, options: { foreignTable?: string } = {}) {
    this.url.searchParams.set(
      options.foreignTable ? `${options.foreignTable}.limit` : "limit",
      String(count),
    );
    return this;
  }

  range(from: number, to: number, options: { foreignTable?: string } = {}) {
    if (options.foreignTable) {
      this.url.searchParams.set(`${options.foreignTable}.offset`, String(from));
      this.url.searchParams.set(`${options.foreignTable}.limit`, String(to - from + 1));
    } else {
      this.headers.set("Range-Unit", "items");
      this.headers.set("Range", `${from}-${to}`);
    }
    return this;
  }

  abortSignal(signal: AbortSignal) {
    this.signal = signal;
    return this;
  }

  single<Result = T extends Array<infer Row> ? Row : T>() {
    this.headers.set("Accept", "application/vnd.pgrst.object+json");
    return this as unknown as PostgrestQueryBuilder<Result>;
  }

  maybeSingle<Result = T extends Array<infer Row> ? Row : T>() {
    this.headers.set("Accept", "application/vnd.pgrst.object+json");
    this.maybeSingleResult = true;
    return this as unknown as PostgrestQueryBuilder<Result | null>;
  }

  private async execute(): Promise<PostgrestResponse<T>> {
    const headers = new Headers(this.headers);
    if (this.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.mode === "rpc" && this.method === "GET") this.method = "POST";

    try {
      const response = await this.fetcher(this.url, {
        method: this.method,
        headers,
        body: this.body === undefined ? undefined : JSON.stringify(this.body),
        signal: this.signal,
        cache: "no-store",
      });
      const raw = this.method === "HEAD" ? "" : await response.text();
      let payload: unknown = null;
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = raw;
        }
      }
      const contentRange = response.headers.get("Content-Range");
      const countText = contentRange?.split("/").at(-1);
      const count = countText && countText !== "*" ? Number(countText) : null;

      if (!response.ok) {
        const error = normalizedError(payload, response.statusText);
        if (
          this.maybeSingleResult &&
          response.status === 406 &&
          error.details?.includes("0 rows")
        ) {
          return {
            data: null,
            error: null,
            count: count !== null && Number.isFinite(count) ? count : null,
            status: 200,
            statusText: "OK",
          };
        }
        return {
          data: null,
          error,
          count: count !== null && Number.isFinite(count) ? count : null,
          status: response.status,
          statusText: response.statusText,
        };
      }

      return {
        data: payload as T,
        error: null,
        count: count !== null && Number.isFinite(count) ? count : null,
        status: response.status,
        statusText: response.statusText,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      return {
        data: null,
        error: {
          code: null,
          details: null,
          hint: null,
          message: "Data API request failed.",
        },
        count: null,
        status: 0,
        statusText: "",
      };
    }
  }

  then<TResult1 = PostgrestResponse<T>, TResult2 = never>(
    onfulfilled?: ((value: PostgrestResponse<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export class PostgrestClient {
  private readonly baseUrl: string;
  private readonly schema: string;
  private readonly headers: HeadersInit;
  private readonly fetcher: typeof fetch;

  constructor(
    baseUrl: string,
    options: {
      schema?: string;
      headers?: HeadersInit;
      fetch?: typeof fetch;
    } = {},
  ) {
    this.baseUrl = baseUrl;
    this.schema = options.schema ?? "public";
    this.headers = options.headers ?? {};
    this.fetcher = options.fetch ?? fetch;
  }

  from(table: string) {
    return new PostgrestQueryBuilder<UntypedData[]>(
      this.baseUrl,
      table,
      "table",
      this.schema,
      this.headers,
      this.fetcher,
    );
  }

  rpc<Result = UntypedData>(functionName: string, args: Record<string, unknown> = {}) {
    const query = new PostgrestQueryBuilder<Result>(
      this.baseUrl,
      functionName,
      "rpc",
      this.schema,
      this.headers,
      this.fetcher,
    );
    return query.insert<Result>(args);
  }
}
