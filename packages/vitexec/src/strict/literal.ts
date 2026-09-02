import ts from "typescript";

export type LiteralResult =
  | { literal: false }
  | { literal: true; value: unknown };

export function literalValue(expression: ts.Expression): LiteralResult {
  const value = unwrap(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return { literal: true, value: value.text };
  }
  if (ts.isNumericLiteral(value)) return { literal: true, value: Number(value.text) };
  if (value.kind === ts.SyntaxKind.TrueKeyword) return { literal: true, value: true };
  if (value.kind === ts.SyntaxKind.FalseKeyword) return { literal: true, value: false };
  if (value.kind === ts.SyntaxKind.NullKeyword) return { literal: true, value: null };
  if (ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken)) {
    const operand = unwrap(value.operand);
    if (ts.isNumericLiteral(operand)) {
      const number = Number(operand.text);
      return {
        literal: true,
        value: value.operator === ts.SyntaxKind.MinusToken ? -number : number
      };
    }
  }
  if (ts.isArrayLiteralExpression(value)) {
    const result: unknown[] = [];
    for (const element of value.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        return { literal: false };
      }
      const item = literalValue(element);
      if (!item.literal) return item;
      result.push(item.value);
    }
    return { literal: true, value: result };
  }
  if (ts.isObjectLiteralExpression(value)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property)) return { literal: false };
      const name = literalPropertyName(property.name);
      if (name === undefined) return { literal: false };
      const item = literalValue(property.initializer);
      if (!item.literal) return item;
      result[name] = item.value;
    }
    return { literal: true, value: result };
  }
  return { literal: false };
}

function literalPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isNumericLiteral(name) ||
    ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (ts.isAsExpression(value) || ts.isNonNullExpression(value) ||
    ts.isParenthesizedExpression(value) || ts.isSatisfiesExpression(value) ||
    ts.isTypeAssertionExpression(value)) {
    value = value.expression;
  }
  return value;
}
