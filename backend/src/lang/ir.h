/* The language's INSTRUCTION FORM: the opcode banks, the builtin and method ids, and
 * the instruction struct every tier is lowered to.
 *
 * This lives with the language rather than with the VM because the language DEFINES the
 * IR and the VM merely executes it — so the dependency runs vm/ -> lang/ and never the
 * reverse, which is what keeps EntityDef, CellDef and the feed/flow tables out of the
 * compiler's headers.
 *
 * One wart, named rather than hidden: OpCode carries both banks (spec 5.4) — the
 * expression opcodes the language emits, and the EFFECT opcodes (MoveOut, CallEnt,
 * TmrStart, Suspend, Fault, Halt) that only the DO-list lowering in compile/ emits and
 * only the VM executes. Splitting the enum means touching the VM's dispatch switch and
 * Instruction's encoding for no behavioural gain, so the language declares opcodes it
 * never emits. */
#pragma once

#include "lang/value.h"

#include <cstdint>

namespace hmi {

/* safety ceilings on genuinely unbounded inputs (PLAN.md: computed bounds, not
 * configured ceilings): an uncapped varr or map truncates here with a fault, and a
 * split can yield at most one piece per input byte */
constexpr uint32_t kVarrCeiling = 512;
constexpr uint32_t kSplitCeiling = 256;
/* THE system ceiling on a RETAINED aggregate cell: how many elements a list variable or
 * a list slot may hold at once (pairs, for a map). It is larger than kVarrCeiling
 * because the two bound different things — kVarrCeiling bounds what one RUN builds in
 * the scratch pool (a mesh delivery, an expression site's worst case), and this bounds
 * what a cell KEEPS across ticks, which is a history ring's whole point. A keep-less
 * append that would cross it refuses loudly rather than growing forever. */
constexpr uint32_t kRetainedCeiling = 4096;

enum class OpCode : uint8_t {
    Const,
    LoadX,
    Load,
    LoadField,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Neg,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Not,
    Jmp,
    JmpFalse,
    Call,
    Method,
    StoreX,
    Gate,
    Deadband,
    Throttle,
    Suspend,
    /* the move step's four forms (spec 5.4). New and ReadEnt fill a struct cell;
     * StoreField sets one field of one; MoveOut emits the effect. A move into a scalar
     * cell is an ordinary expression plus Store, so it needs no opcode of its own. */
    New,
    ReadEnt,
    LoadEnt,
    StoreField,
    MoveOut,
    Store,
    TmrStart,
    TmrCancel,
    Fault,
    Halt,
    /* appended only: the frontend's attribute interpreter mirrors these ids */
    Index,
    /* text -> the enum value whose variant name it is, over the type table entry in
     * `b`: the compile-inserted coercion at a move into an enum-typed field, so a
     * Dropdown's selected name writes back with no authored transform (spec 6.2) */
    EnumFromName,
    /* pop; jump to `a` when it was Nil: a cased feed's bail-out, so an UNKNOWN input
     * stores UNKNOWN instead of faulting its way down the arms (spec 2.4) */
    JmpNil,
    /* push one FIELD of timer `a` from the timer table (`b`: 0 running, 1 remaining
     * seconds, 2 duration seconds): expressions read a timer only by field, the way
     * `myTimer.remaining` spells it; the state lives beside the cells, not in one */
    TmrRead,
    /* pop `b` values (pushed left to right) into a fresh element run and push the
     * list: the `[a, b, c]` array literal, how an expression builds a list without
     * reading one. A Nil element stays Nil (a gap is a value), it does not poison the
     * whole list. */
    MakeList,
    /* The ONE iterating opcode (spec 6.4): pop a list, run sub-program `a` once per
     * element with that element bound as the body's parameter, and push the result the
     * mode in `small` asks for. `b` is the TRIP BOUND taken from the schema at compile,
     * so the worst-case step count of the whole program stays computable and this is
     * still not a loop in any sense the determinism checklist (5.10) forbids.
     *
     * One opcode rather than five because the modes differ only in what they do with
     * each body result, and a single VM case keeps the sub-program plumbing -- the
     * stack frame, the trip bound, the element window -- written once. */
    Iterate,
    /* APPEND ONE ELEMENT to list cell `a` (`b`: the fault site). The stack reads
     * [value, keep] -- keep comes off first, having been pushed last. A non-Nil keep
     * trims the front to that many elements, which is what makes a history ring one
     * authored step instead of a privileged machine; a Nil keep means unbounded, and
     * the append REFUSES at the retained ceiling rather than growing forever. The one
     * verb that changes a list without replacing it. */
    Append,
    /* WRITE ONE KEY of map cell `a` (`b`: the fault site). The stack reads [value, key]
     * -- key comes off first. A Nil value ERASES the key: a map has no other removal
     * verb, and "this key holds UNKNOWN" and "this key is absent" would otherwise be two
     * spellings of one thing. Keys stay sorted, so iteration is replay-deterministic. */
    StoreKey,
    /* push EVENT PARAMETER `a` (state.args): what the triggering event passed in, bound
     * by the parameter's declared name at compile. State-resident rather than a run_code
     * register so a lambda body can read it without colliding with its own x2/x3. */
    LoadArg,
    /* RAISE the event in Program.raises[`a`] (`b`: 1 = pop one argument value off the
     * stack, 0 = nullary; `c`: the fault site for a full raise buffer). The record is
     * queued on the state and the scheduler dispatches it AFTER this run halts — a raise
     * never re-enters the VM under the raising flow. */
    Raise,
};

/* what Iterate does with each element's body result (rides Instruction::small) */
enum class IterateMode : uint16_t {
    Map,      /* the body result becomes the element        -> list */
    Filter,   /* keep the element where the body is true    -> list */
    Any,      /* true if the body is true for any element   -> bool */
    All,      /* true if the body is true for every element -> bool */
    SortBy,   /* order the elements by the body's value     -> list */
    /* fold: the body takes the accumulator and the element and returns the next
     * accumulator, starting from the initial value the call's second argument pushed.
     * The one mode that consumes TWO stack operands (list then init) and the one whose
     * result shape is the body's rather than the receiver's. */
    Reduce,
};

enum class Builtin : uint16_t {
    Clamp,
    MapRange,
    RoundTo,
    Lerp,
    Abs,
    Round,
    Floor,
    Ceil,
    Sqrt,
    Pow,
    Min,
    Max,
    Int,
    Num,
    Rgb,
    Hsv,
    /* appended only: the frontend's attribute interpreter mirrors these ids */
    Str,
    Name,
    FmtTime,
    FmtDuration,
    Color,
    Jet,
    Hot,
    CoolWarm,
    Viridis,
    Grayscale,
    Values,
    Keys,
    Invert,
    /* ordinary trigonometry, degrees in and out (the project-wide angle convention):
     * both tiers gain these together, which is the piece that unblocks authoring a
     * needle's capsule or an arc's annular sector as arithmetic instead of a hard-coded
     * draw kind */
    Sin,
    Cos,
    Tan,
    Asin,
    Acos,
    Atan2,
};

enum class MethodId : uint16_t {
    NumRound,
    NumFloor,
    NumCeil,
    NumAbs,
    NumClamp,
    NumMapRange,
    NumSign,
    BoolInt,
    BoolNot,
    BoolPick,
    ColorR,
    ColorG,
    ColorB,
    ColorA,
    ColorAlpha,
    ColorMix,
    /* appended only: the frontend's attribute interpreter mirrors these ids */
    NumToFixed,
    TextLength,
    TextUpper,
    TextLower,
    TextTitle,
    TextTrim,
    TextSlice,
    TextStartsWith,
    TextEndsWith,
    TextContains,
    TextReplace,
    TextPadStart,
    EnumInt,
    EnumName,
    TextSplit,
    ListLength,
    ListFirst,
    ListLast,
    ListSum,
    ListAvg,
    ListMax,
    ListMin,
    ListJoin,
    ListSort,
    ListReverse,
    ListSlice,
    ListContains,
    ListIndexOf,
    MapLength,
    MapKeys,
    MapValues,
    MapHas,
    MapGet,
    /* `a + b` with a text operand (display tier): both sides rendered as str() would
     * render them, joined into the site's own slot */
    TextConcat,
    /* color channel arithmetic: `color * n` / `color / n` scale r,g,b (alpha kept),
     * `.invert()` flips them */
    ColorScale,
    ColorDiv,
    ColorInvert,
};

struct Instruction {
    OpCode op = OpCode::Halt;
    uint8_t flags = 0;
    uint16_t small = 0;
    uint32_t a = 0;
    uint32_t b = 0;
    uint32_t c = 0;
};

static_assert(sizeof(Instruction) == 16, "Instruction must stay compact");

} // namespace hmi
