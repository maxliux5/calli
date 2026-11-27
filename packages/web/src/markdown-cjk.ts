/**
 * CJK-friendly emphasis (`*` / `**`) for micromark / remark.
 *
 * CommonMark rejects a closing `**` when it is immediately preceded by punctuation and followed by
 * a letter without intervening space (for example a bold span ending in full-width parentheses
 * right before a CJK character). Chinese, Japanese, and Korean prose does not put spaces around
 * full-width punctuation or words, so such bold spans leak literal `**` markers.
 *
 * Following the `markdown-cjk-friendly` flanking amendment, this overrides only the `*` tokenizer
 * while leaving `_` untouched (so `snake_case` identifiers stay literal) and reuses CommonMark's
 * own attention resolver.
 */

type Code = number | null;
type CharClass = 'space' | 'cjkPunct' | 'cjk' | 'punct' | 'other';

interface AttentionToken {
  type: string;
  _open?: boolean;
  _close?: boolean;
}

interface Effects {
  enter(type: string): AttentionToken;
  consume(code: Code): void;
  exit(type: string): AttentionToken;
}

interface TokenizeContext {
  previous: Code;
  parser: {
    constructs: {
      attentionMarkers: { null?: number[] };
    };
  };
}

type State = (code: Code) => State | undefined;

const ASCII_PUNCT = /^[!-/:-@[\]^_`{-~]$/;
const UNICODE_PUNCT = /\p{P}/u;
const UNICODE_SPACE = /\s/;

function isCjkPunctuation(code: number): boolean {
  return (
    (code >= 0x3001 && code <= 0x303f) ||
    (code >= 0xff01 && code <= 0xff0f) ||
    (code >= 0xff1a && code <= 0xff20) ||
    (code >= 0xff3b && code <= 0xff40) ||
    (code >= 0xff5b && code <= 0xff65) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6b)
  );
}

function isCjkCharacter(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3100 && code <= 0x312f) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0x31f0 && code <= 0x31ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x20000 && code <= 0x2fa1f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}

function classify(code: Code): CharClass {
  // Micromark encodes EOF as null and line endings / virtual spaces as negative integers.
  if (code === null || code < 0 || code === 9 || code === 32) return 'space';
  if (code > 127) {
    if (isCjkPunctuation(code)) return 'cjkPunct';
    if (isCjkCharacter(code)) return 'cjk';
    const ch = String.fromCodePoint(code);
    if (UNICODE_SPACE.test(ch)) return 'space';
    if (UNICODE_PUNCT.test(ch)) return 'punct';
    return 'other';
  }
  if (ASCII_PUNCT.test(String.fromCharCode(code))) return 'punct';
  return 'other';
}

function tokenizeCjkAsterisk(this: TokenizeContext, effects: Effects, ok: State): State {
  const attentionMarkers = this.parser.constructs.attentionMarkers.null ?? [];
  const previous = this.previous;
  const before = classify(previous);
  const markerAllowed = (code: Code) =>
    code !== null && attentionMarkers.includes(code) && code !== 42 && code !== 95;

  function start(code: Code): State | undefined {
    effects.enter('attentionSequence');
    return inside(code);
  }

  function inside(code: Code): State | undefined {
    if (code === 42) {
      effects.consume(code);
      return inside;
    }
    const token = effects.exit('attentionSequence');
    const after = classify(code);
    // Left/right flanking with CJK punctuation treated as non-blocking and CJK scripts allowed
    // beside non-CJK punctuation, preserving standard CommonMark behavior for pure ASCII runs.
    token._open = (after !== 'space' && (after !== 'punct' || before !== 'other')) || markerAllowed(code);
    token._close = (before !== 'space' && (before !== 'punct' || after !== 'other')) || markerAllowed(previous);
    return ok(code);
  }

  return start;
}

interface AttentionConstruct {
  name?: string;
  resolveAll?: (events: unknown[], context: ResolveContext) => unknown[];
}

interface ResolveContext {
  parser: {
    constructs: {
      insideSpan: { null?: AttentionConstruct[] };
    };
  };
}

function resolveCjkAttention(events: unknown[], context: ResolveContext): unknown[] {
  const core = context.parser.constructs.insideSpan.null?.find((c) => c.name === 'attention');
  return core?.resolveAll ? core.resolveAll(events, context) : events;
}

const cjkAsteriskExtension = {
  text: {
    [42]: {
      name: 'cjkAttention',
      tokenize: tokenizeCjkAsterisk,
      resolveAll: resolveCjkAttention,
    },
  },
};

/** Remark plugin that fixes CJK and full-width punctuation boundaries around `*` / `**`. */
export function remarkCjkEmphasis(this: { data(): object }) {
  const data = this.data() as Record<string, unknown>;
  const extensions = (data.micromarkExtensions ??= []) as unknown[];
  extensions.push(cjkAsteriskExtension);
}
