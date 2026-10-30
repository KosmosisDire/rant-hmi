// What handler code sees, built in each run's context from the host's `__` functions: each
// object with its members, an object's own code its members as plain names too, the mesh's
// enums, `Pages`, open and close, notify, log, sleep and the screen's `theme`.
(imports, objects, pages, enums) => {
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

  // a later name of a kind hides an earlier one, so the nearest is defined last
  const define = (at, name, how) => Object.defineProperty(at, name, { ...how, enumerable: true, configurable: true });

  // an enum by its type's name, its options a fresh list at each read as a value's are
  for (const { name, options } of enums) {
    define(globalThis, name, { value: Object.freeze({ get options() { return [...options]; } }) });
  }

  // each object, which holds the members code outside it reads
  const spaces = Object.fromEntries(objects.map((name) => [name, {}]));
  for (const [name, space] of Object.entries(spaces)) define(globalThis, name, { value: space });

  // each by the name code gives it, on its object or bare, read and written under its key
  for (const { name, alias, kind, object } of imports) {
    const at = object === undefined ? globalThis : spaces[object];
    if (kind === "topic") {
      define(at, name, { get: () => topic(alias), set: (v) => write(alias, v) });
    } else if (kind === "function" || kind === "task") {
      // none is an empty request. A task's last function takes each progress update, and
      // its own cancel stops every call of it, as what a call gives stops that one.
      const call = (...args) => {
        const progress = kind === "task" && typeof args.at(-1) === "function" ? watched(args.pop()) : undefined;
        return __call(alias, args.length === 0 ? {} : shape(alias, alias, args), progress);
      };
      if (kind === "task") call.cancel = () => __cancel(alias);
      define(at, name, { value: call });
    } else if (kind === "fn") {
      define(at, name, { value: (...args) => __run(alias, args) });
    } else {
      define(at, name, { get: () => wrap(alias, read(alias), []), set: (v) => write(alias, v) });
    }
  }
  for (const space of Object.values(spaces)) Object.freeze(space);

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
  globalThis.theme = Object.freeze({
    get mode() {
      return __mode();
    },
    set: (mode) => __setMode(String(mode)),
    toggle: () => __setMode(__mode() === "dark" ? "light" : "dark"),
  });

  // How a run ended, in words for the person who wrote it. A call's failure comes from
  // another realm, so its message tells it apart, not its class.
  const describe = (e) => {
    if (typeof e?.message !== "string") return text(e);
    if (e.message === "interrupted") return __stopped();
    if (e.name === "CallError") return `${e.message} (${e.status.replaceAll("_", " ")})`;
    const line = /handler:(\d+)/.exec(e.stack ?? "");
    const message = e.message.replace(/^'?([\w$]+)'? is not defined$/, "$1 names no object, member or state");
    return line ? `${message} (line ${Number(line[1]) - 1})` : message;
  };
  globalThis.__finish = (e) => (e instanceof Unknown ? __end("unknown", e.alias) : __end("fault", describe(e)));
  // each progress update runs as a job of its own, so one that throws is told and the call goes on
  const watched = (f) => (v) => void Promise.resolve(v).then(f).catch((e) => __fault(describe(e)));
  globalThis.__describe = describe;
};
