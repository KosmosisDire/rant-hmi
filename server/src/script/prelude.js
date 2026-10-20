// What handler code sees, built in each run's context from the host's `__` functions: the
// imports as plain names, `Pages`, open and close, notify, log and sleep.
(imports, pages) => {
  class Unknown extends Error {
    constructor(alias) {
      super(`${alias} is unknown`);
      this.name = "Unknown";
      this.alias = alias;
    }
  }

  // each read is a fresh copy, so changing it changes nothing until it is written
  const read = (alias) => {
    const value = __read(alias);
    if (value === undefined) throw new Unknown(alias);
    return value;
  };

  const write = (alias, value) => {
    if (value === undefined) throw new TypeError(`${alias} cannot be set to undefined`);
    __write(alias, value);
  };

  // A value whose fields take assignment: each one writes the whole value back with that
  // field changed, so fields set together go out as one value. Bytes stay as they are.
  const wrap = (alias, value, path) => {
    if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
    return new Proxy(value, {
      get: (target, key) => (typeof key === "symbol" ? target[key] : wrap(alias, target[key], [...path, key])),
      set: (target, key, v) => {
        const whole = read(alias);
        let at = whole;
        for (const step of path) at = at[step];
        at[key] = v;
        write(alias, whole);
        target[key] = v;
        return true;
      },
    });
  };

  // A message or request from what code passes: one value whole, or its fields in order. A
  // lone object is the whole, unless its one field is an object and the object lacks its name.
  const shape = (call, alias, args) => {
    const form = __form(alias);
    if (!form || args.length === 0) return args[0];
    const { name, fields } = form;
    const [first] = args;
    const whole = first !== null && typeof first === "object" && !Array.isArray(first) && !ArrayBuffer.isView(first);
    if (args.length === 1 && (fields.length === 0 || (whole && (fields.length > 1 || fields[0] in first)))) return first;
    if (args.length === fields.length) return Object.fromEntries(fields.map((f, i) => [f, args[i]]));
    const type = name || "value";
    throw new TypeError(fields.length === 0 ? `${call} takes one ${type}` : `${call} takes ${fields.join(", ")}, or one ${type} with them`);
  };

  // A topic reads as its latest message, and `send` publishes one, read or not.
  const topic = (alias) =>
    new Proxy(
      {},
      {
        get: (_, key) => (key === "send" ? (...args) => __send(alias, shape(`${alias}.send`, alias, args) ?? null) : wrap(alias, read(alias), [])[key]),
        has: (_, key) => key in read(alias),
        ownKeys: () => Reflect.ownKeys(read(alias)),
        getOwnPropertyDescriptor: (_, key) => ({ value: read(alias)[key], enumerable: true, configurable: true }),
      },
    );

  for (const { alias, kind } of imports) {
    if (kind === "topic") {
      Object.defineProperty(globalThis, alias, { get: () => topic(alias), set: (v) => write(alias, v), enumerable: true });
    } else if (kind === "function") {
      // none is an empty request
      const call = (...args) => __call(alias, args.length === 0 ? {} : shape(alias, alias, args));
      Object.defineProperty(globalThis, alias, { value: call, enumerable: true });
    } else {
      Object.defineProperty(globalThis, alias, {
        get: () => wrap(alias, read(alias), []),
        set: (v) => write(alias, v),
        enumerable: true,
      });
    }
  }

  // a value as words for a notice or the log: bytes by their count, the rest as code writes it
  const shown = (_, x) => (x instanceof Uint8Array ? `${x.length} bytes` : typeof x === "bigint" ? String(x) : x);
  const text = (v) => (typeof v === "string" ? v : String(JSON.stringify(shown("", v), shown)));
  globalThis.notify = (v) => __notify(text(v));
  globalThis.log = (...values) => __log(values.map(text).join(" "));
  globalThis.sleep = (ms) => __sleep(Number(ms) || 0);
  globalThis.Pages = Object.freeze(Object.fromEntries(pages.map(({ key, id }) => [key, id])));
  // open waits for what the page closes with, close answers it
  globalThis.open = (page, options) => __open(String(page), options?.replace === true);
  globalThis.close = (answer) => __close(answer ?? null);

  // How a run ended, in words for the person who wrote it. A call's failure comes from
  // another realm, so its message tells it apart, not its class.
  const describe = (e) => {
    if (typeof e?.message !== "string") return text(e);
    if (e.message === "interrupted") return `it ran ${__budget()} ms without waiting, so it was stopped`;
    if (e.name === "CallError") return `${e.message} (${e.status.replaceAll("_", " ")})`;
    const line = /handler:(\d+)/.exec(e.stack ?? "");
    const message = e.message.replace(/^'?([\w$]+)'? is not defined$/, "$1 names no mesh import, variable or record");
    return line ? `${message} (line ${Number(line[1]) - 1})` : message;
  };
  globalThis.__finish = (e) => (e instanceof Unknown ? __end("unknown", e.alias) : __end("fault", describe(e)));
  globalThis.__describe = describe;
};
