export type SourceSpan = {
  start: number;
  end: number;
  line: number;
  column: number;
};

export type SAtom = {
  kind: "atom";
  value: string;
  quoted: boolean;
  span: SourceSpan;
};

export type SList = {
  kind: "list";
  items: SExpr[];
  span: SourceSpan;
};

export type SExpr = SAtom | SList;

type Token = {
  kind: "open" | "close" | "atom";
  value: string;
  quoted: boolean;
  start: number;
  end: number;
  line: number;
  column: number;
};

export class SExpressionError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly column: number,
  ) {
    super(`${message} at ${line}:${column}`);
    this.name = "SExpressionError";
  }
}

function tokenize(source: string, maxTokens: number): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > maxTokens) {
      throw new SExpressionError(`Token limit ${maxTokens} exceeded`, line, column);
    }
  };

  const advance = (character: string) => {
    index += 1;
    if (character === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  };

  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      advance(character);
      continue;
    }
    if (character === ";") {
      while (index < source.length && source[index] !== "\n") advance(source[index]);
      continue;
    }

    const start = index;
    const tokenLine = line;
    const tokenColumn = column;
    if (character === "(" || character === ")") {
      advance(character);
      push({
        kind: character === "(" ? "open" : "close",
        value: character,
        quoted: false,
        start,
        end: index,
        line: tokenLine,
        column: tokenColumn,
      });
      continue;
    }

    if (character === '"') {
      advance(character);
      let value = "";
      let closed = false;
      while (index < source.length) {
        const current = source[index];
        if (current === '"') {
          advance(current);
          closed = true;
          break;
        }
        if (current === "\\") {
          const escapeLine = line;
          const escapeColumn = column;
          advance(current);
          if (index >= source.length) {
            throw new SExpressionError("Unterminated escape", escapeLine, escapeColumn);
          }
          const escaped = source[index];
          const decoded: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            '"': '"',
            "\\": "\\",
          };
          value += decoded[escaped] ?? escaped;
          advance(escaped);
          continue;
        }
        value += current;
        advance(current);
      }
      if (!closed) throw new SExpressionError("Unterminated quoted string", tokenLine, tokenColumn);
      push({
        kind: "atom",
        value,
        quoted: true,
        start,
        end: index,
        line: tokenLine,
        column: tokenColumn,
      });
      continue;
    }

    let value = "";
    while (index < source.length && !/[\s()]/.test(source[index])) {
      value += source[index];
      advance(source[index]);
    }
    push({
      kind: "atom",
      value,
      quoted: false,
      start,
      end: index,
      line: tokenLine,
      column: tokenColumn,
    });
  }
  return tokens;
}

export function parseSExpression(
  source: string,
  options: { maxDepth?: number; maxTokens?: number } = {},
): SList {
  const maxDepth = options.maxDepth ?? 256;
  const tokens = tokenize(source, options.maxTokens ?? 2_000_000);
  const document: SList = {
    kind: "list",
    items: [],
    span: { start: 0, end: source.length, line: 1, column: 1 },
  };
  const stack: SList[] = [document];

  for (const token of tokens) {
    if (token.kind === "open") {
      if (stack.length > maxDepth) {
        throw new SExpressionError(`Nesting limit ${maxDepth} exceeded`, token.line, token.column);
      }
      const list: SList = {
        kind: "list",
        items: [],
        span: {
          start: token.start,
          end: token.end,
          line: token.line,
          column: token.column,
        },
      };
      stack[stack.length - 1].items.push(list);
      stack.push(list);
      continue;
    }
    if (token.kind === "close") {
      if (stack.length === 1) {
        throw new SExpressionError("Unexpected closing parenthesis", token.line, token.column);
      }
      const completed = stack.pop()!;
      completed.span.end = token.end;
      continue;
    }
    stack[stack.length - 1].items.push({
      kind: "atom",
      value: token.value,
      quoted: token.quoted,
      span: {
        start: token.start,
        end: token.end,
        line: token.line,
        column: token.column,
      },
    });
  }

  if (stack.length !== 1) {
    const unclosed = stack[stack.length - 1];
    throw new SExpressionError("Unclosed list", unclosed.span.line, unclosed.span.column);
  }
  return document;
}

export function head(node: SExpr): string | undefined {
  return node.kind === "list" && node.items[0]?.kind === "atom"
    ? node.items[0].value
    : undefined;
}

export function atom(node: SExpr | undefined): string | undefined {
  return node?.kind === "atom" ? node.value : undefined;
}

export function directChildren(node: SList, childHead?: string): SList[] {
  return node.items.filter(
    (item): item is SList => item.kind === "list" && (!childHead || head(item) === childHead),
  );
}

export function firstChild(node: SList, childHead: string): SList | undefined {
  return directChildren(node, childHead)[0];
}

export function valueAt(node: SList | undefined, index = 1): string | undefined {
  return node ? atom(node.items[index]) : undefined;
}

export function childValue(node: SList, childHead: string, index = 1): string | undefined {
  return valueAt(firstChild(node, childHead), index);
}

export function allDescendants(node: SList, childHead?: string): SList[] {
  const result: SList[] = [];
  const pending = [...directChildren(node)];
  while (pending.length) {
    const current = pending.pop()!;
    if (!childHead || head(current) === childHead) result.push(current);
    pending.push(...directChildren(current));
  }
  return result;
}

export function rootExpression(document: SList): SList | undefined {
  return directChildren(document)[0];
}
