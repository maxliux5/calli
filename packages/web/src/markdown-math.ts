import katex from 'katex';
import { createElement, type ComponentProps, type ReactNode } from 'react';
import type { Components } from 'react-markdown';

/**
 * LaTeX math parsing and KaTeX rendering for Markdown replies and documents.
 *
 * Math is tokenized inside micromark before CommonMark parses emphasis or backslash escapes, so
 * `_`, `*`, `\\`, `\{`, and `\text{...}` reach KaTeX intact. Block math supports single-line and
 * multi-line `$$...$$` and `\[...\]`. Inline math supports `\(...\)`, `\[...\]`, `$$...$$`, and
 * strictly guarded `$...$` (excluding currency amounts like `$5-$10` and shell variables like
 * `$HOME/$PATH`, and validating single-dollar candidates with KaTeX before claiming them).
 */

type Code = number | null;
type State = (code: Code) => State | undefined;

interface Token {
  type: string;
}

interface Effects {
  enter(type: string): Token;
  consume(code: Code): void;
  exit(type: string): Token;
  check(construct: Construct, ok: State, nok: State): State;
  attempt(construct: Construct, ok: State, nok: State): State;
}

interface Construct {
  name?: string;
  concrete?: boolean;
  partial?: boolean;
  tokenize: (this: TokenizeContext, effects: Effects, ok: State, nok: State) => State;
}

interface TokenizeContext {
  previous: Code;
  events: Array<[string, Token, { sliceSerialize(token: Token, expandTabs?: boolean): string }]>;
  parser: { lazy: Record<number, boolean> };
  now(): { line: number };
}

interface CompileContext {
  enter(node: Record<string, unknown>, token: Token): void;
  exit(token: Token): void;
  buffer(): void;
  resume(): string;
  config: { enter: Record<string, unknown>; exit: Record<string, unknown> };
  sliceSerialize(token: Token): string;
}

const isLineEnding = (code: Code): boolean => code === -5 || code === -4 || code === -3;
const isSpace = (code: Code): boolean => code === -2 || code === -1 || code === 9 || code === 32;
const isAsciiAlnum = (code: Code): boolean =>
  code !== null &&
  ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122));

const nonLazyContinuation: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    const self = this;
    function start(code: Code): State | undefined {
      if (code === null || !isLineEnding(code)) return nok(code);
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      return after;
    }
    function after(code: Code): State | undefined {
      return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
    }
    return start;
  },
};

/** Consumes optional spaces/tabs and succeeds only at EOL or EOF. */
const trailingWhitespaceToEnd: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    function scan(code: Code): State | undefined {
      if (isSpace(code)) {
        effects.consume(code);
        return scan;
      }
      if (code === null || isLineEnding(code)) return ok(code);
      return nok(code);
    }
    return scan;
  },
};

/**
 * Display math fenced by `$$` (two or more `$`).
 * Supports both single-line `$$...$$` and multi-line `$$\n...\n$$`. Requires an explicit closing
 * fence before EOF so a stray `$$` (or an unfinished streamed formula) never swallows later text.
 */
const mathFlowDollar: Construct = {
  name: 'mathFlowDollar',
  concrete: true,
  tokenize(effects, ok, nok) {
    let sizeOpen = 0;
    let hasContent = false;

    const closeOnSameLine: Construct = {
      partial: true,
      tokenize(closeEffects, closeOk, closeNok) {
        let count = 0;
        function startClose(code: Code): State | undefined {
          closeEffects.enter('mathFlowFence');
          return seq(code);
        }
        function seq(code: Code): State | undefined {
          if (code === 36) {
            count++;
            closeEffects.consume(code);
            return seq;
          }
          if (count !== sizeOpen) return closeNok(code);
          return closeEffects.check(trailingWhitespaceToEnd, closeTail, closeNok)(code);
        }
        function closeTail(code: Code): State | undefined {
          if (isSpace(code)) {
            closeEffects.consume(code);
            return closeTail;
          }
          closeEffects.exit('mathFlowFence');
          return closeOk(code);
        }
        return startClose;
      },
    };

    /** Detects a premature `$$` followed by prose on line 1 (e.g. `$$a$$ and $$b$$`). */
    const sameSizeDelimiter: Construct = {
      partial: true,
      tokenize(checkEffects, checkOk, checkNok) {
        let count = 0;
        function seq(code: Code): State | undefined {
          if (code === 36) {
            count++;
            checkEffects.consume(code);
            return seq;
          }
          return count === sizeOpen ? checkOk(code) : checkNok(code);
        }
        return seq;
      },
    };

    const closeOwnLine: Construct = {
      partial: true,
      tokenize(closeEffects, closeOk, closeNok) {
        let indent = 0;
        let count = 0;
        function startClose(code: Code): State | undefined {
          closeEffects.enter('mathFlowFence');
          return prefix(code);
        }
        function prefix(code: Code): State | undefined {
          if (isSpace(code) && indent < 3) {
            indent++;
            closeEffects.consume(code);
            return prefix;
          }
          if (code === 36) return seq(code);
          return closeNok(code);
        }
        function seq(code: Code): State | undefined {
          if (code === 36) {
            count++;
            closeEffects.consume(code);
            return seq;
          }
          if (count < sizeOpen) return closeNok(code);
          return tail(code);
        }
        function tail(code: Code): State | undefined {
          if (isSpace(code)) {
            closeEffects.consume(code);
            return tail;
          }
          if (code === null || isLineEnding(code)) {
            closeEffects.exit('mathFlowFence');
            return closeOk(code);
          }
          return closeNok(code);
        }
        return startClose;
      },
    };

    function start(code: Code): State | undefined {
      if (code !== 36) return nok(code);
      effects.enter('mathFlow');
      effects.enter('mathFlowFence');
      return openSequence(code);
    }

    function openSequence(code: Code): State | undefined {
      if (code === 36) {
        sizeOpen++;
        effects.consume(code);
        return openSequence;
      }
      if (sizeOpen < 2) return nok(code);
      effects.exit('mathFlowFence');
      return afterOpen(code);
    }

    function afterOpen(code: Code): State | undefined {
      if (isSpace(code)) {
        effects.consume(code);
        return afterOpen;
      }
      if (code === null) return nok(code);
      if (isLineEnding(code)) return nextLine(code);
      // Content begins on the opening line (single-line `$$...$$` or `$$a +\nb$$`).
      return firstLineStart(code);
    }

    function firstLineStart(code: Code): State | undefined {
      let backslashes = 0;
      let inValue = false;

      function enterValue() {
        if (!inValue) {
          effects.enter('mathFlowValue');
          inValue = true;
        }
      }
      function exitValue() {
        if (inValue) {
          effects.exit('mathFlowValue');
          inValue = false;
        }
      }

      function scan(c: Code): State | undefined {
        if (c === null) {
          exitValue();
          return nok(c);
        }
        if (isLineEnding(c)) {
          exitValue();
          return nextLine(c);
        }
        if (c === 36 && backslashes % 2 === 0) {
          exitValue();
          return effects.attempt(
            closeOnSameLine,
            finishSingleLine,
            effects.check(sameSizeDelimiter, rejectProseOnSameLine, consumeLiteralDollar),
          )(c);
        }
        if (c === 92) backslashes++;
        else backslashes = 0;
        if (!isSpace(c)) hasContent = true;
        enterValue();
        effects.consume(c);
        return scan;
      }

      function finishSingleLine(c: Code): State | undefined {
        if (!hasContent) return nok(c);
        effects.exit('mathFlow');
        return ok(c);
      }

      function rejectProseOnSameLine(c: Code): State | undefined {
        return nok(c);
      }

      function consumeLiteralDollar(c: Code): State | undefined {
        backslashes = 0;
        hasContent = true;
        enterValue();
        effects.consume(c);
        return scan;
      }

      return scan(code);
    }

    function nextLine(code: Code): State | undefined {
      return effects.check(nonLazyContinuation, atContinuation, failUnclosed)(code);
    }

    function failUnclosed(code: Code): State | undefined {
      return nok(code);
    }

    function atContinuation(code: Code): State | undefined {
      effects.enter('mathFlowLineEnding');
      effects.consume(code);
      effects.exit('mathFlowLineEnding');
      return lineStart;
    }

    function lineStart(code: Code): State | undefined {
      if (code === null) return nok(code);
      if (isLineEnding(code)) return nextLine(code);
      return effects.attempt(closeOwnLine, finishMultiLine, scanBodyLine)(code);
    }

    function finishMultiLine(code: Code): State | undefined {
      if (!hasContent) return nok(code);
      effects.exit('mathFlow');
      return ok(code);
    }

    function scanBodyLine(code: Code): State | undefined {
      let backslashes = 0;
      let inValue = false;

      function enterValue() {
        if (!inValue) {
          effects.enter('mathFlowValue');
          inValue = true;
        }
      }
      function exitValue() {
        if (inValue) {
          effects.exit('mathFlowValue');
          inValue = false;
        }
      }

      function scan(c: Code): State | undefined {
        if (c === null) {
          exitValue();
          return nok(c);
        }
        if (isLineEnding(c)) {
          exitValue();
          return nextLine(c);
        }
        if (c === 36 && backslashes % 2 === 0) {
          exitValue();
          return effects.attempt(closeOnSameLine, finishMultiLine, consumeDollar)(c);
        }
        if (c === 92) backslashes++;
        else backslashes = 0;
        if (!isSpace(c)) hasContent = true;
        enterValue();
        effects.consume(c);
        return scan;
      }

      function consumeDollar(c: Code): State | undefined {
        backslashes = 0;
        hasContent = true;
        enterValue();
        effects.consume(c);
        return scan;
      }

      return scan(code);
    }

    return start;
  },
};

/**
 * Display math fenced by `\[` and `\]`.
 * Supports single-line `\[ E = mc^2 \]` and multi-line `\[\n...\n\]`.
 */
const mathFlowBracket: Construct = {
  name: 'mathFlowBracket',
  concrete: true,
  tokenize(effects, ok, nok) {
    let hasContent = false;

    const closeBracketAtEnd: Construct = {
      partial: true,
      tokenize(closeEffects, closeOk, closeNok) {
        function slash(code: Code): State | undefined {
          if (code !== 92) return closeNok(code);
          closeEffects.enter('mathFlowFence');
          closeEffects.consume(code);
          return bracket;
        }
        function bracket(code: Code): State | undefined {
          if (code !== 93) return closeNok(code);
          closeEffects.consume(code);
          return tail;
        }
        function tail(code: Code): State | undefined {
          if (isSpace(code)) {
            closeEffects.consume(code);
            return tail;
          }
          if (code === null || isLineEnding(code)) {
            closeEffects.exit('mathFlowFence');
            return closeOk(code);
          }
          return closeNok(code);
        }
        return slash;
      },
    };

    const closeBracketOwnLine: Construct = {
      partial: true,
      tokenize(closeEffects, closeOk, closeNok) {
        let indent = 0;
        function prefix(code: Code): State | undefined {
          if (isSpace(code) && indent < 3) {
            indent++;
            closeEffects.enter('linePrefix');
            closeEffects.consume(code);
            closeEffects.exit('linePrefix');
            return prefix;
          }
          return closeEffects.attempt(closeBracketAtEnd, closeOk, closeNok)(code);
        }
        return prefix;
      },
    };

    const rawCloseBracket: Construct = {
      partial: true,
      tokenize(checkEffects, checkOk, checkNok) {
        function slash(code: Code): State | undefined {
          if (code !== 92) return checkNok(code);
          checkEffects.consume(code);
          return bracket;
        }
        function bracket(code: Code): State | undefined {
          if (code !== 93) return checkNok(code);
          checkEffects.consume(code);
          return checkOk(code);
        }
        return slash;
      },
    };

    function start(code: Code): State | undefined {
      if (code !== 92) return nok(code);
      effects.enter('mathFlow');
      effects.enter('mathFlowFence');
      effects.consume(code);
      return openBracket;
    }

    function openBracket(code: Code): State | undefined {
      if (code !== 91) return nok(code);
      effects.consume(code);
      effects.exit('mathFlowFence');
      return afterOpen;
    }

    function afterOpen(code: Code): State | undefined {
      if (isSpace(code)) {
        effects.consume(code);
        return afterOpen;
      }
      if (code === null) return nok(code);
      if (isLineEnding(code)) return nextLine(code);
      return scanLine(code, true);
    }

    function nextLine(code: Code): State | undefined {
      return effects.check(nonLazyContinuation, atContinuation, failUnclosed)(code);
    }

    function failUnclosed(code: Code): State | undefined {
      return nok(code);
    }

    function atContinuation(code: Code): State | undefined {
      effects.enter('mathFlowLineEnding');
      effects.consume(code);
      effects.exit('mathFlowLineEnding');
      return lineStart;
    }

    function lineStart(code: Code): State | undefined {
      if (code === null) return nok(code);
      if (isLineEnding(code)) return nextLine(code);
      return effects.attempt(closeBracketOwnLine, finish, (c) => scanLine(c, false))(code);
    }

    function finish(code: Code): State | undefined {
      if (!hasContent) return nok(code);
      effects.exit('mathFlow');
      return ok(code);
    }

    function scanLine(code: Code, firstLine: boolean): State | undefined {
      let backslashes = 0;
      let inValue = false;

      function enterValue() {
        if (!inValue) {
          effects.enter('mathFlowValue');
          inValue = true;
        }
      }
      function exitValue() {
        if (inValue) {
          effects.exit('mathFlowValue');
          inValue = false;
        }
      }

      function scan(c: Code): State | undefined {
        if (c === null) {
          exitValue();
          return nok(c);
        }
        if (isLineEnding(c)) {
          exitValue();
          return nextLine(c);
        }
        if (c === 92 && backslashes % 2 === 0) {
          exitValue();
          return effects.attempt(
            closeBracketAtEnd,
            finish,
            firstLine
              ? effects.check(rawCloseBracket, failUnclosed, consumeBackslash)
              : consumeBackslash,
          )(c);
        }
        if (c === 92) backslashes++;
        else backslashes = 0;
        if (!isSpace(c)) hasContent = true;
        enterValue();
        effects.consume(c);
        return scan;
      }

      function consumeBackslash(c: Code): State | undefined {
        backslashes++;
        hasContent = true;
        enterValue();
        effects.consume(c);
        return scan;
      }

      return scan(code);
    }

    return start;
  },
};

const TEXT_COMMAND = /\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt|operatorname|mbox|hbox|textbf|textit)\s*\{/g;
const CJK_OR_FULLWIDTH = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const CURRENCY_PROSE = /^\d[\d.,]*[,;]\s+[A-Za-z]{2,}/;

/** Strips balanced `\text{...}`-like groups so CJK inside text commands passes while bare CJK fails. */
function stripTextCommandGroups(tex: string): string {
  let out = '';
  let at = 0;
  TEXT_COMMAND.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEXT_COMMAND.exec(tex)) !== null) {
    out += tex.slice(at, match.index);
    let i = match.index + match[0].length;
    let depth = 1;
    while (i < tex.length && depth > 0) {
      const ch = tex[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    at = i;
    TEXT_COMMAND.lastIndex = i;
  }
  return out + tex.slice(at);
}

/**
 * Guard for single-dollar `$...$` spans so currency amounts and shell variables are never misparsed.
 * Only called after boundary checks pass, then verified with strict KaTeX parsing.
 */
function isPlausibleSingleDollarMath(tex: string): boolean {
  if (!tex || !tex.trim()) return false;
  if (CJK_OR_FULLWIDTH.test(stripTextCommandGroups(tex))) return false;
  if (!tex.includes('\\') && CURRENCY_PROSE.test(tex)) return false;
  return renderMathToHtml(tex, false, true) !== null;
}

/**
 * Inline math delimited by `$$...$$` or strictly guarded `$...$`.
 */
const mathTextDollar: Construct = {
  name: 'mathTextDollar',
  tokenize(effects, ok, nok) {
    const previous = this.previous;
    let sizeOpen = 0;

    function start(code: Code): State | undefined {
      if (code !== 36) return nok(code);
      effects.enter('mathText');
      effects.enter('mathTextFence');
      return openSequence(code);
    }

    function openSequence(code: Code): State | undefined {
      if (code === 36) {
        sizeOpen++;
        effects.consume(code);
        return openSequence;
      }
      effects.exit('mathTextFence');
      if (sizeOpen === 1) return startSingle(code);
      return startDouble(code);
    }

    function startSingle(code: Code): State | undefined {
      if (previous === 36 || isAsciiAlnum(previous)) return nok(code);
      if (code === null || isLineEnding(code) || isSpace(code) || code === 36) return nok(code);
      let raw = '';
      let escaped = false;
      let lastCode: Code = null;

      effects.enter('mathTextValue');

      function scan(c: Code): State | undefined {
        if (c === null || isLineEnding(c)) return nok(c);
        if (c === 36 && !escaped) {
          if (isSpace(lastCode)) return nok(c);
          effects.exit('mathTextValue');
          effects.enter('mathTextFence');
          effects.consume(c);
          effects.exit('mathTextFence');
          return afterSingleClose;
        }
        escaped = c === 92 ? !escaped : false;
        lastCode = c;
        raw += String.fromCodePoint(c);
        effects.consume(c);
        return scan;
      }

      function afterSingleClose(c: Code): State | undefined {
        // Reject `$5-$10`, `$HOME/$PATH`, `$(a)/$(b)`, `${A}/${B}`, and adjacent `$$`.
        if (c === 36 || isAsciiAlnum(c) || c === 95 || c === 40 || c === 123) return nok(c);
        if (!isPlausibleSingleDollarMath(raw)) return nok(c);
        effects.exit('mathText');
        return ok(c);
      }

      return scan(code);
    }

    function startDouble(code: Code): State | undefined {
      if (code === null) return nok(code);
      let hasContent = false;
      let backslashes = 0;
      let sawLineEnding = false;
      let inValue = false;

      const closeSeq: Construct = {
        partial: true,
        tokenize(closeEffects, closeOk, closeNok) {
          let count = 0;
          function seq(c: Code): State | undefined {
            if (c === 36) {
              count++;
              closeEffects.consume(c);
              return seq;
            }
            return count === sizeOpen ? closeOk(c) : closeNok(c);
          }
          return seq;
        },
      };

      function enterValue() {
        if (!inValue) {
          effects.enter('mathTextValue');
          inValue = true;
        }
      }
      function exitValue() {
        if (inValue) {
          effects.exit('mathTextValue');
          inValue = false;
        }
      }

      function scan(c: Code): State | undefined {
        if (c === null) {
          exitValue();
          return nok(c);
        }
        if (isLineEnding(c)) {
          if (sawLineEnding) {
            exitValue();
            return nok(c);
          }
          sawLineEnding = true;
          backslashes = 0;
          exitValue();
          effects.enter('mathTextLineEnding');
          effects.consume(c);
          effects.exit('mathTextLineEnding');
          return scan;
        }
        sawLineEnding = false;
        if (c === 36 && backslashes % 2 === 0) {
          exitValue();
          return effects.attempt(closeSeq, finishDouble, consumeDollar)(c);
        }
        if (c === 92) backslashes++;
        else backslashes = 0;
        if (!isSpace(c)) hasContent = true;
        enterValue();
        effects.consume(c);
        return scan;
      }

      function consumeDollar(c: Code): State | undefined {
        backslashes = 0;
        hasContent = true;
        enterValue();
        effects.consume(c);
        return scan;
      }

      function finishDouble(c: Code): State | undefined {
        if (!hasContent) return nok(c);
        effects.exit('mathText');
        return ok(c);
      }

      return scan(code);
    }

    return start;
  },
};

/**
 * Inline math delimited by `\(...\)` or mid-paragraph `\[...\]`.
 * Runs before CommonMark's `characterEscape` on `\` and falls back via `nok` when unclosed.
 */
const mathTextBracket: Construct = {
  name: 'mathTextBracket',
  tokenize(effects, ok, nok) {
    let closeCode = 0;
    let hasContent = false;
    let backslashes = 0;
    let sawLineEnding = false;
    let inValue = false;

    const closeDelim: Construct = {
      partial: true,
      tokenize(closeEffects, closeOk, closeNok) {
        function slash(c: Code): State | undefined {
          if (c !== 92) return closeNok(c);
          closeEffects.consume(c);
          return closing;
        }
        function closing(c: Code): State | undefined {
          if (c !== closeCode) return closeNok(c);
          closeEffects.consume(c);
          return closeOk;
        }
        return slash;
      },
    };

    function enterValue() {
      if (!inValue) {
        effects.enter('mathTextValue');
        inValue = true;
      }
    }
    function exitValue() {
      if (inValue) {
        effects.exit('mathTextValue');
        inValue = false;
      }
    }

    function start(code: Code): State | undefined {
      if (code !== 92) return nok(code);
      effects.enter('mathText');
      effects.enter('mathTextFence');
      effects.consume(code);
      return openDelim;
    }

    function openDelim(code: Code): State | undefined {
      if (code === 40) closeCode = 41; // \( ... \)
      else if (code === 91) closeCode = 93; // \[ ... \]
      else return nok(code);
      effects.consume(code);
      effects.exit('mathTextFence');
      return scan;
    }

    function scan(code: Code): State | undefined {
      if (code === null) {
        exitValue();
        return nok(code);
      }
      if (isLineEnding(code)) {
        if (sawLineEnding) {
          exitValue();
          return nok(code);
        }
        sawLineEnding = true;
        backslashes = 0;
        exitValue();
        effects.enter('mathTextLineEnding');
        effects.consume(code);
        effects.exit('mathTextLineEnding');
        return scan;
      }
      sawLineEnding = false;
      if (code === 92 && backslashes % 2 === 0) {
        exitValue();
        return effects.attempt(closeDelim, finish, consumeBackslash)(code);
      }
      if (code === 92) backslashes++;
      else backslashes = 0;
      if (!isSpace(code)) hasContent = true;
      enterValue();
      effects.consume(code);
      return scan;
    }

    function consumeBackslash(code: Code): State | undefined {
      backslashes++;
      hasContent = true;
      enterValue();
      effects.consume(code);
      return scan;
    }

    function finish(code: Code): State | undefined {
      if (!hasContent) return nok(code);
      effects.exit('mathText');
      return ok(code);
    }

    return start;
  },
};

const mathMicromarkExtension = {
  flow: {
    [36]: mathFlowDollar,
    [92]: mathFlowBracket,
  },
  text: {
    [36]: mathTextDollar,
    [92]: mathTextBracket,
  },
};

function enterMathFlow(this: CompileContext, token: Token) {
  this.enter(
    {
      type: 'math',
      value: '',
      data: {
        hName: 'div',
        hProperties: { className: ['math-display'], dataMath: '', dataMathDisplay: 'true' },
        hChildren: [{ type: 'text', value: '' }],
      },
    },
    token,
  );
  this.buffer();
}

function exitMathFlow(this: CompileContext, token: Token) {
  const value = this.resume().trim();
  const node = (this as unknown as { stack: Array<Record<string, unknown>> }).stack.at(-1);
  if (node) {
    node.value = value;
    const data = node.data as {
      hProperties: Record<string, unknown>;
      hChildren: Array<{ type: string; value: string }>;
    };
    data.hProperties.dataMath = value;
    data.hChildren[0]!.value = `$$${value}$$`;
  }
  this.exit(token);
}

function enterMathText(this: CompileContext, token: Token) {
  this.enter(
    {
      type: 'inlineMath',
      value: '',
      data: {
        hName: 'span',
        hProperties: { className: ['math-inline'], dataMath: '' },
        hChildren: [{ type: 'text', value: '' }],
      },
    },
    token,
  );
  this.buffer();
}

function exitMathText(this: CompileContext, token: Token) {
  const value = this.resume().trim();
  const node = (this as unknown as { stack: Array<Record<string, unknown>> }).stack.at(-1);
  if (node) {
    node.value = value;
    const data = node.data as {
      hProperties: Record<string, unknown>;
      hChildren: Array<{ type: string; value: string }>;
    };
    data.hProperties.dataMath = value;
    data.hChildren[0]!.value = `$${value}$`;
  }
  this.exit(token);
}

function exitMathData(this: CompileContext, token: Token) {
  const enter = this.config.enter.data as (this: CompileContext, token: Token) => void;
  const exit = this.config.exit.data as (this: CompileContext, token: Token) => void;
  enter.call(this, token);
  exit.call(this, token);
}

const mathFromMarkdownExtension = {
  canContainEols: ['inlineMath'],
  enter: {
    mathFlow: enterMathFlow,
    mathText: enterMathText,
  },
  exit: {
    mathFlow: exitMathFlow,
    mathText: exitMathText,
    mathFlowValue: exitMathData,
    mathTextValue: exitMathData,
    mathFlowLineEnding: exitMathData,
    mathTextLineEnding: exitMathData,
  },
};

/** Remark plugin that parses block and inline LaTeX math into KaTeX-ready nodes. */
export function remarkMath(this: { data(): object }) {
  const data = this.data() as Record<string, unknown>;
  const micromarkExtensions = (data.micromarkExtensions ??= []) as unknown[];
  const fromMarkdownExtensions = (data.fromMarkdownExtensions ??= []) as unknown[];
  micromarkExtensions.push(mathMicromarkExtension);
  fromMarkdownExtensions.push(mathFromMarkdownExtension);
}

const KATEX_CACHE_LIMIT = 400;
const katexCache = new Map<string, string | null>();

/**
 * Renders one LaTeX expression to KaTeX HTML. `strict: 'ignore'` permits CJK inside `\text{...}`
 * without noisy warnings, and `trust: false` blocks unsafe commands such as `\href` / `\htmlClass`.
 */
export function renderMathToHtml(tex: string, displayMode: boolean, throwOnError = false): string | null {
  const key = `${displayMode ? 'D' : 'I'}${throwOnError ? 'S' : 'L'}:${tex}`;
  const cached = katexCache.get(key);
  if (cached !== undefined) return cached;
  let html: string | null = null;
  try {
    html = katex.renderToString(tex, {
      displayMode,
      throwOnError,
      strict: 'ignore',
      trust: false,
      maxExpand: 1000,
      errorColor: 'var(--warn)',
    });
  } catch {
    html = null;
  }
  if (katexCache.size >= KATEX_CACHE_LIMIT) katexCache.clear();
  katexCache.set(key, html);
  return html;
}

/** Reads the TeX source from a math element produced by `remarkMath`, or `null` for other nodes. */
export function mathSourceOf(props: Record<string, unknown>): { tex: string; display: boolean } | null {
  const tex = props['data-math'];
  if (typeof tex !== 'string' || !tex) return null;
  return { tex, display: props['data-math-display'] === 'true' };
}

/** Renders a display math `<div>` when the element carries `data-math`; returns `null` otherwise. */
export function renderMathDiv(props: ComponentProps<'div'> & { node?: unknown }): ReactNode | null {
  const math = mathSourceOf(props as Record<string, unknown>);
  if (!math) return null;
  const html = renderMathToHtml(math.tex, true);
  if (html === null) return createElement('div', { className: 'math-display math-fallback' }, props.children);
  return createElement('div', {
    className: 'math-display',
    dangerouslySetInnerHTML: { __html: html },
  });
}

/** Renders an inline math `<span>` when the element carries `data-math`; returns `null` otherwise. */
export function renderMathSpan(props: ComponentProps<'span'> & { node?: unknown }): ReactNode | null {
  const math = mathSourceOf(props as Record<string, unknown>);
  if (!math) return null;
  const html = renderMathToHtml(math.tex, false);
  if (html === null) return createElement('span', { className: 'math-inline math-fallback' }, props.children);
  return createElement('span', {
    className: 'math-inline',
    dangerouslySetInnerHTML: { __html: html },
  });
}

function MathDiv({ node: _node, ...props }: ComponentProps<'div'> & { node?: unknown }) {
  return renderMathDiv(props) ?? createElement('div', props);
}

function MathSpan({ node: _node, ...props }: ComponentProps<'span'> & { node?: unknown }) {
  return renderMathSpan(props) ?? createElement('span', props);
}

/** React-markdown component overrides that turn `remarkMath` nodes into KaTeX markup. */
export const MATH_COMPONENTS: Components = {
  div: MathDiv,
  span: MathSpan,
};
