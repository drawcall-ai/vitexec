import ts from "typescript";
import {
  createStrictProgram,
  diagnosticIssue,
  sourceIssue
} from "./program.js";
import type {
  StrictSourceIssue,
  StrictSourceVerification,
  VerifyStrictSourceOptions
} from "./types.js";
import { validateObservationProjection } from "../observe/fields.js";
import { parseInputCommand } from "../input/parse.js";
import { literalValue } from "./literal.js";

// Strict source can only observe provider JSON, compute locally, log, and send
// direct physical input. Syntax that can hide execution is rejected by category.

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
]);

const IMPLICIT_CALL_BINARY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.InstanceOfKeyword
]);

const PASSIVE_CONSOLE_METHODS = new Set([
  "debug",
  "error",
  "info",
  "log",
  "trace",
  "warn"
]);

const APPROVED_CAPABILITY_NAMES = new Set(["input", "observe"]);

const PHYSICAL_INPUT_TYPES = new Set([
  "keyboard.down",
  "keyboard.press",
  "keyboard.up",
  "mouse.click",
  "mouse.down",
  "mouse.move",
  "mouse.moveLatest",
  "mouse.moveTo",
  "mouse.press",
  "mouse.stop",
  "mouse.up",
  "wait"
]);

class StrictSubsetVerifier {
  readonly #bindings = new Map<string, number>();
  readonly #issues: StrictSourceIssue[] = [];
  readonly #sourceFile: ts.SourceFile;
  readonly #variables = new Set<string>();
  #hasInputImport = false;
  #hasObserveImport = false;

  constructor(sourceFile: ts.SourceFile) {
    this.#sourceFile = sourceFile;
    this.#collectBindings(this.#sourceFile);
  }

  verify(): StrictSourceIssue[] {
    this.#visit(this.#sourceFile);
    return this.#issues;
  }

  #collectBindings(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      this.#bindings.set(name, (this.#bindings.get(name) ?? 0) + 1);
      this.#variables.add(name);
    } else if (ts.isImportSpecifier(node)) {
      this.#bindings.set(node.name.text, (this.#bindings.get(node.name.text) ?? 0) + 1);
      if (!node.propertyName && !node.isTypeOnly) {
        if (node.name.text === "input") this.#hasInputImport = true;
        if (node.name.text === "observe") this.#hasObserveImport = true;
      }
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      this.#bindings.set(node.name.text, (this.#bindings.get(node.name.text) ?? 0) + 1);
    } else if (
      ts.isCatchClause(node) &&
      node.variableDeclaration &&
      ts.isIdentifier(node.variableDeclaration.name)
    ) {
      const name = node.variableDeclaration.name.text;
      this.#bindings.set(name, (this.#bindings.get(name) ?? 0) + 1);
    }
    ts.forEachChild(node, (child) => this.#collectBindings(child));
  }

  #visit(node: ts.Node): void {
    if (ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0) {
      this.#reject(
        node,
        "external-call",
        "Decorators are outside the strict subset because they execute during class lowering."
      );
    }
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword ||
        modifier.kind === ts.SyntaxKind.DefaultKeyword
    )) {
      this.#reject(node, "escape-hatch", "Exports are outside the strict subset.");
    }

    if (ts.isImportDeclaration(node)) {
      if (!this.#isApprovedCapabilityImport(node)) {
        this.#reject(
          node,
          "escape-hatch",
          "Only direct named imports of input and observe from \"vitexec\" are allowed in strict source."
        );
      }
    } else if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
      this.#reject(node, "escape-hatch", "Exports are outside the strict subset.");
    } else if (ts.isCallExpression(node)) {
      this.#checkCall(node);
    } else if (ts.isNewExpression(node)) {
      this.#checkConstruction(node);
    } else if (ts.isTaggedTemplateExpression(node)) {
      this.#reject(
        node,
        "external-call",
        "Tagged templates are outside the strict subset."
      );
    } else if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
    ) {
      this.#checkAssignment(node);
    } else if (ts.isBinaryExpression(node)) {
      this.#checkBinaryOperation(node);
    } else if (ts.isDeleteExpression(node)) {
      this.#reject(
        node,
        "external-write",
        "Delete operations are outside the strict subset."
      );
    } else if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      this.#reject(
        node,
        "external-write",
        "Update expressions are outside the strict subset."
      );
    } else if (ts.isPostfixUnaryExpression(node)) {
      this.#reject(
        node,
        "external-write",
        "Update expressions are outside the strict subset."
      );
    } else if (ts.isPrefixUnaryExpression(node)) {
      this.#checkUnaryOperation(node);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      this.#reject(
        node,
        "external-call",
        "Protocol-driven loops are outside the strict subset."
      );
    } else if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
      this.#reject(
        node,
        "external-call",
        "Spread is outside the strict subset because it executes an iterator or enumeration."
      );
    } else if (ts.isAwaitExpression(node)) {
      const expression = this.#unwrap(node.expression);
      if (!ts.isCallExpression(expression) ||
        !this.#isApprovedInputCall(expression)) {
        this.#reject(
          node,
          "external-call",
          "Only a direct approved input call may be awaited in strict source."
        );
      }
    } else if (ts.isYieldExpression(node)) {
      this.#reject(node, "external-call", "Yield is outside the strict subset.");
    } else if (ts.isTemplateExpression(node)) {
      this.#reject(
        node,
        "external-call",
        "Interpolated templates are outside the strict subset because interpolation coerces values."
      );
    } else if (ts.isElementAccessExpression(node)) {
      if (!node.argumentExpression ||
        !this.#isStaticPropertyKey(node.argumentExpression)) {
        this.#reject(
          node,
          "external-call",
          "Computed reads require a literal property key in strict source."
        );
      }
    } else if (ts.isComputedPropertyName(node)) {
      this.#reject(
        node,
        "external-call",
        "Computed property definitions are outside the strict subset."
      );
    } else if (ts.isVariableDeclaration(node)) {
      this.#checkVariableDeclaration(node);
    } else if (ts.isIdentifier(node)) {
      this.#checkIdentifier(node);
    } else if (this.#isUnsupportedDeclaration(node)) {
      this.#reject(
        node,
        "unsupported-syntax",
        "Functions, classes, enums, namespaces, and type declarations are outside the strict subset."
      );
    } else if (this.#isJsx(node)) {
      this.#reject(
        node,
        "external-call",
        "JSX is outside the strict subset because its factory call is introduced after verification."
      );
    } else if (
      ts.isThrowStatement(node) ||
      ts.isWithStatement(node) ||
      ts.isDebuggerStatement(node)
    ) {
      this.#reject(
        node,
        "unsupported-syntax",
        "Throw, with, and debugger statements are outside the strict subset."
      );
    }

    ts.forEachChild(node, (child) => this.#visit(child));
  }

  #checkCall(call: ts.CallExpression): void {
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
      this.#reject(
        call,
        "escape-hatch",
        "Dynamic imports are outside the strict subset."
      );
      return;
    }
    if (this.#isApprovedInputCall(call)) {
      this.#checkInputCall(call);
      return;
    }
    if (this.#isApprovedObserveCall(call)) {
      this.#checkObservationCall(call);
      return;
    }
    if (this.#isPassiveConsoleCall(call)) {
      return;
    }
    const expression = this.#unwrap(call.expression);
    if (
      (ts.isIdentifier(expression) &&
        this.#isGlobalIdentifier(expression) &&
        (expression.text === "eval" || expression.text === "Function")) ||
      this.#containsConstructorAccess(expression)
    ) {
      this.#reject(
        call,
        "escape-hatch",
        "Dynamic code evaluation is outside the strict subset."
      );
      return;
    }
    this.#reject(
      call,
      "external-call",
      "Only a direct approved input call or passive console observation is allowed."
    );
  }

  #checkConstruction(node: ts.NewExpression): void {
    const expression = this.#unwrap(node.expression);
    if (
      (ts.isIdentifier(expression) &&
        expression.text === "Function" &&
        this.#isGlobalIdentifier(expression)) ||
      this.#containsConstructorAccess(expression)
    ) {
      this.#reject(
        node,
        "escape-hatch",
        "Dynamic code construction is outside the strict subset."
      );
      return;
    }
    this.#reject(
      node,
      "external-call",
      "Construction is outside the strict subset."
    );
  }

  #checkAssignment(node: ts.BinaryExpression): void {
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
      this.#reject(
        node,
        "external-call",
        "Compound and logical assignments are outside the strict subset."
      );
      return;
    }
    const target = this.#unwrap(node.left);
    if (ts.isIdentifier(target) && this.#variables.has(target.text)) return;
    this.#reject(
      node.left,
      "external-write",
      "Only direct assignment to a source-local variable is allowed."
    );
  }

  #checkBinaryOperation(node: ts.BinaryExpression): void {
    if (IMPLICIT_CALL_BINARY_OPERATORS.has(node.operatorToken.kind)) {
      this.#reject(
        node,
        "external-call",
        "The in and instanceof operators are outside the strict subset."
      );
    }
  }

  #checkUnaryOperation(_node: ts.PrefixUnaryExpression): void {}

  #checkVariableDeclaration(node: ts.VariableDeclaration): void {
    if (!ts.isIdentifier(node.name)) {
      this.#reject(
        node.name,
        "external-call",
        "Destructuring declarations are outside the strict subset."
      );
    }
    if (this.#isAmbient(node)) {
      this.#reject(
        node,
        "escape-hatch",
        "Ambient declarations are outside the strict subset because they refer to page globals."
      );
    }
    if (
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Using) !== 0
    ) {
      this.#reject(
        node,
        "external-call",
        "Resource declarations are outside the strict subset."
      );
    }
  }

  #checkIdentifier(node: ts.Identifier): void {
    if (this.#bindings.has(node.text) ||
      node.text === "console" ||
      node.text === "Infinity" ||
      node.text === "NaN" ||
      node.text === "undefined" ||
      this.#isSyntacticName(node) ||
      this.#isTypeIdentifier(node)) {
      return;
    }
    this.#reject(
      node,
      "external-call",
      "Strict source must read application state through observe(...)."
    );
  }

  #isApprovedCapabilityImport(node: ts.ImportDeclaration): boolean {
    if (!ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "vitexec") {
      return false;
    }
    const clause = node.importClause;
    if (
      !clause ||
      clause.isTypeOnly ||
      clause.phaseModifier ||
      clause.name ||
      node.attributes
    ) {
      return false;
    }
    const bindings = clause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) ||
      bindings.elements.length === 0 || bindings.elements.length > 2) {
      return false;
    }
    const names = new Set<string>();
    for (const binding of bindings.elements) {
      if (binding.isTypeOnly || binding.propertyName ||
        !APPROVED_CAPABILITY_NAMES.has(binding.name.text) ||
        names.has(binding.name.text)) {
        return false;
      }
      names.add(binding.name.text);
    }
    return true;
  }

  #isApprovedInputCall(call: ts.CallExpression): boolean {
    const callee = this.#unwrap(call.expression);
    return ts.isIdentifier(callee) && callee.text === "input" &&
      this.#hasInputImport && this.#bindings.get("input") === 1;
  }

  #checkInputCall(call: ts.CallExpression): void {
    if (!ts.isAwaitExpression(call.parent)) {
      this.#reject(call, "external-call", "Input calls must be awaited in strict source.");
    }
    if (call.arguments.length !== 1) {
      this.#reject(
        call,
        "external-call",
        "Input requires one literal physical command."
      );
      return;
    }
    const command = this.#unwrap(call.arguments[0]);
    if (!ts.isObjectLiteralExpression(command)) {
      this.#reject(
        call,
        "external-call",
        "Input requires one literal physical command."
      );
      return;
    }
    const typeProperties = command.properties.filter((property) =>
      ts.isPropertyAssignment(property) && this.#literalPropertyName(property.name) === "type"
    );
    const typeProperty = typeProperties.length === 1 ? typeProperties[0] : undefined;
    if (!typeProperty || !ts.isPropertyAssignment(typeProperty)) {
      this.#reject(
        call,
        "external-call",
        "Input requires one literal physical command."
      );
      return;
    }
    const type = this.#unwrap(typeProperty.initializer);
    if (!ts.isStringLiteral(type) || !PHYSICAL_INPUT_TYPES.has(type.text)) {
      this.#reject(
        call,
        "escape-hatch",
        "Only literal physical input commands are allowed in strict source."
      );
      return;
    }
    const literal = literalValue(command);
    if (literal.literal) {
      try {
        parseInputCommand(literal.value);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        this.#reject(call, "external-call", error.message);
      }
    }
  }

  #isApprovedObserveCall(call: ts.CallExpression): boolean {
    const callee = this.#unwrap(call.expression);
    return ts.isIdentifier(callee) && callee.text === "observe" &&
      this.#hasObserveImport && this.#bindings.get("observe") === 1;
  }

  #checkObservationCall(call: ts.CallExpression): void {
    if (call.arguments.length === 0) return;
    if (!this.#observationProjectionKeys(call)) {
      this.#reject(
        call,
        "external-call",
        "Observe requires one literal projection with 1-32 safe fields, each containing a primitive kind, a static path of 1-16 segments, and optional literal nullable and optional flags."
      );
    }
  }

  #observationProjectionKeys(call: ts.CallExpression): Set<string> | undefined {
    if (call.arguments.length !== 1) return undefined;
    const projection = literalValue(call.arguments[0]);
    if (!projection.literal) return undefined;
    try {
      return new Set(validateObservationProjection(projection.value).keys());
    } catch {
      return undefined;
    }
  }

  #literalPropertyName(name: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) ||
      ts.isNoSubstitutionTemplateLiteral(name)) {
      return name.text;
    }
    return undefined;
  }

  #isPassiveConsoleCall(call: ts.CallExpression): boolean {
    const callee = this.#unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) ||
      !PASSIVE_CONSOLE_METHODS.has(callee.name.text)) {
      return false;
    }
    const receiver = this.#unwrap(callee.expression);
    return ts.isIdentifier(receiver) &&
      receiver.text === "console" &&
      this.#isGlobalIdentifier(receiver);
  }

  #containsConstructorAccess(expression: ts.Expression): boolean {
    let value = this.#unwrap(expression);
    while (ts.isPropertyAccessExpression(value)) {
      if (value.name.text === "constructor") return true;
      value = this.#unwrap(value.expression);
    }
    return false;
  }

  #isStaticPropertyKey(expression: ts.Expression): boolean {
    const value = this.#unwrap(expression);
    return ts.isBigIntLiteral(value) ||
      ts.isNoSubstitutionTemplateLiteral(value) ||
      ts.isNumericLiteral(value) ||
      ts.isStringLiteral(value);
  }

  #isGlobalIdentifier(identifier: ts.Identifier): boolean {
    return !this.#bindings.has(identifier.text);
  }

  #isSyntacticName(node: ts.Identifier): boolean {
    const parent = node.parent;
    return (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isLabeledStatement(parent) && parent.label === node) ||
      ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node);
  }

  #isTypeIdentifier(node: ts.Identifier): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isExpression(current) && !ts.isStatement(current)) {
      if (ts.isTypeNode(current)) return true;
      current = current.parent;
    }
    return false;
  }

  #isAmbient(node: ts.Node): boolean {
    let current: ts.Node | undefined = node;
    while (current && current !== this.#sourceFile) {
      if (ts.canHaveModifiers(current) && ts.getModifiers(current)?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword
      )) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  #isUnsupportedDeclaration(node: ts.Node): boolean {
    return ts.isFunctionLike(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isImportEqualsDeclaration(node);
  }

  #isJsx(node: ts.Node): boolean {
    return ts.isJsxElement(node) ||
      ts.isJsxFragment(node) ||
      ts.isJsxSelfClosingElement(node);
  }

  #unwrap(expression: ts.Expression): ts.Expression {
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

  #reject(
    node: ts.Node,
    code: StrictSourceIssue["code"],
    message: string
  ): void {
    this.#issues.push(sourceIssue(this.#sourceFile, node, code, message));
  }
}

export function verifyStrictSource(
  source: string,
  options: VerifyStrictSourceOptions = {}
): StrictSourceVerification {
  const language = options.language ?? "typescript";
  const { diagnostics, sourceFile } = createStrictProgram(source, language);
  const parseIssues = diagnostics
    .map((diagnostic) => diagnosticIssue(sourceFile, diagnostic));
  if (parseIssues.length > 0) return { issues: parseIssues, ok: false };

  const issues = new StrictSubsetVerifier(sourceFile).verify();
  return { issues, ok: issues.length === 0 };
}

export function assertStrictSource(
  source: string,
  options: VerifyStrictSourceOptions = {}
): void {
  const result = verifyStrictSource(source, options);
  if (result.ok) return;
  const details = result.issues.map((issue) =>
    `${issue.code} at ${issue.start.line}:${issue.start.column}: ${issue.message}`
  );
  throw new Error(`Strict source verification failed: ${details.join("; ")}`);
}
