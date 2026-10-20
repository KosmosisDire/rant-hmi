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

  const read = (alias) => {
    const json = __read(alias);
    if (json === undefined) throw new Unknown(alias);
    return JSON.parse(json);
  };

  const write = (alias, value) => {
    if (value === undefined) throw new TypeError(`${alias} cannot be set to undefined`);
    __write(alias, JSON.stringify(value));
  };

  // A value whose fields take assignment: each one writes the whole value back with that
  // field changed, so fields set together go out as one value.
  const wrap = (alias, value, path) => {
    if (value === null || typeof value !== "object") return value;
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

  // A topic reads as its latest message, and `send` publishes one, read or not.
  const topic = (alias) =>
    new Proxy(
      {},
      {
        get: (_, key) => (key === "send" ? (msg) => __send(alias, JSON.stringify(msg ?? null)) : wrap(alias, read(alias), [])[key]),
        has: (_, key) => key in read(alias),
        ownKeys: () => Reflect.ownKeys(read(alias)),
        getOwnPropertyDescriptor: (_, key) => ({ value: read(alias)[key], enumerable: true, configurable: true }),
      },
    );

  for (const { alias, kind } of imports) {
    if (kind === "topic") {
      Object.defineProperty(globalThis, alias, { get: () => topic(alias), set: (v) => write(alias, v), enumerable: true });
    } else if (kind === "function") {
      // one value is sent bare, none as an empty request
      const call = (...args) => __call(alias, JSON.stringify(args.length === 0 ? {} : args[0]));
      Object.defineProperty(globalThis, alias, { value: call, enumerable: true });
    } else {
      Object.defineProperty(globalThis, alias, {
        get: () => wrap(alias, read(alias), []),
        set: (v) => write(alias, v),
        enumerable: true,
      });
    }
  }

  const text = (v) => (typeof v === "string" ? v : JSON.stringify(v));
  globalThis.notify = (v) => __notify(text(v));
  globalThis.log = (...values) => __log(values.map(text).join(" "));
  globalThis.sleep = (ms) => __sleep(Number(ms) || 0);
  globalThis.Pages = Object.freeze(Object.fromEntries(pages.map(({ key, id }) => [key, id])));
  // open waits for what the page closes with, close answers it
  globalThis.open = (page, options) => __open(String(page), options?.replace === true);
  globalThis.close = (answer) => __close(JSON.stringify(answer ?? null));

  // How a run ended, in words for the person who wrote it. A call's failure comes from
  // another realm, so its message tells it apart, not its class.
  const describe = (e) => {
    if (typeof e?.message !== "string") return text(e);
    if (e.message === "interrupted") return `it ran ${__budget()} ms without waiting, so it was stopped`;
    if (e.name === "CallError") return `${e.message} (${e.status.replaceAll("_", " ")})`;
    const line = /handler:(\d+)/.exec(e.stack ?? "");
    const message = e.message.replace(/^'?([\w$]+)'? is not defined$/, "$1 names no mesh import or variable");
    return line ? `${message} (line ${Number(line[1]) - 1})` : message;
  };
  globalThis.__finish = (e) => (e instanceof Unknown ? __end("unknown", e.alias) : __end("fault", describe(e)));
  globalThis.__describe = describe;
};
