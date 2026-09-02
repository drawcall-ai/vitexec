import ts from "typescript";
import { parseInputCommand } from "../input/parse.js";

type LiteralValue = boolean | null | number | string;

type LiteralResult =
  | { literal: false }
  | { literal: true; value: LiteralValue };

export function literalInputCommandError(
  command: ts.ObjectLiteralExpression
): string | undefined {
  const value: Record<string, unknown> = {};
  for (const property of command.properties) {
    if (!ts.isPropertyAssignment(property)) return undefined;
    const name = literalPropertyName(property.name);
    if (name === undefined) return undefined;
    const result = literalValue(property.initializer);
    if (!result.literal) return undefined;
    value[name] = result.value;
  }

  try {
    parseInputCommand(value);
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
}

function literalPropertyName(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isNumericLiteral(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function literalValue(expression: ts.Expression): LiteralResult {
  const value = unwrap(expression);
  if (
    ts.isStringLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value)
  ) {
    return { literal: true, value: value.text };
  }
  if (ts.isNumericLiteral(value)) {
    return { literal: true, value: Number(value.text) };
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword) {
    return { literal: true, value: true };
  }
  if (value.kind === ts.SyntaxKind.FalseKeyword) {
    return { literal: true, value: false };
  }
  if (value.kind === ts.SyntaxKind.NullKeyword) {
    return { literal: true, value: null };
  }
  if (
    ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.PlusToken ||
      value.operator === ts.SyntaxKind.MinusToken)
  ) {
    const operand = unwrap(value.operand);
    if (ts.isNumericLiteral(operand)) {
      const magnitude = Number(operand.text);
      return {
        literal: true,
        value: value.operator === ts.SyntaxKind.MinusToken ? -magnitude : magnitude
      };
    }
  }
  return { literal: false };
}

function unwrap(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (
    ts.isAsExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isParenthesizedExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isTypeAssertionExpression(value)
  ) {
    value = value.expression;
  }
  return value;
}
