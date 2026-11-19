# Types

What code gives is worked out from what it reads, without running it, by one analyser that
completion, call hints and the name card all read.

## The question

The user's, on 2026-11-19, after completion failed past `length()`, then past brackets, then
past `.toFixed(1) + "kg"`: each fix was a patch over the last one. "We need a general system
for type analysis."

What failed each time: completion read the path before a dot as text, so anything but names,
fields and calls of Rant Math broke it, and nothing said what JavaScript's own methods give.

## Decisions

- One module, `client/src/lang/types.js`, plain JS so Node tests read it as they read api.js.
- A type is one of number, string, bool, colour, bytes, date, unknown, a list of a type, a map
  of a type, a struct of fields (named where it is a standard type), or a function.
- Type words are the ones component inputs use (`number`, `bool`, `string`, a type's name,
  `[]` for a list), with `colour`, `bytes`, `date`, `unknown`, `{}` for a map and
  `{ a: T, b: T }` for a struct.
- Where types come from:
  - the mesh: each import's schema;
  - Rant Math: its table gives every call's and operator's output type;
  - the language: api.js gives each name a `gives` in those words;
  - JavaScript: types.js declares number, string, list, bytes and date methods, and `Math`,
    `JSON`, `Object`, `Array` and `Date`;
  - a value with no type of its own: read from the value.
- A value rides along where it is known now, worked out only by calls that change nothing:
  JavaScript's own methods that change nothing, Rant Math, the language's math. A list method
  that changes the list, as `push`, is declared but never run.
- A list method's function is typed with the item as its value, so `rant.statuses().map((c) =>`
  knows `c` is a condition, and gives a list of what the function returns.
- Code cut short at the caret parses with acorn-loose, and what it declares on the way down to
  the caret is in scope there: the statements before it, each function's values as its caller
  calls it, a loop's item, a caught error.
- The editor gives the analyser its names in `client/src/state/typed.ts`: each object a struct of
  its members, typed by the mesh with their values now, the tokens, the language's names in each
  place, and names given nearer. A topic's send and a task's cancel are members of their type.
- A mesh call says its values with the mesh's own types, as `f64`, since those are what it sends.
- The tests are a scenario, `lang-types`, that runs in Node beside the backend, which gives the
  standard types.

## Steps

1. The model and the declarations. Done.
2. The analyser over acorn's tree, with tests. Done.
3. Names code declares before the caret, read with acorn's loose parser. Done. acorn-loose is
   vendored beside acorn, at 8.5.2.
4. Completion, call hints and the name card on the analyser, and the patches in complete.ts
   removed. Done.
