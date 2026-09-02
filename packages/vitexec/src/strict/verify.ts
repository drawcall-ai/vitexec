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
import {
  FORBIDDEN_OBSERVATION_KEYS,
  MAXIMUM_OBSERVATION_FIELDS,
  MAXIMUM_OBSERVATION_PATH_DEPTH,
  OBSERVATION_KINDS
} from "../observe/policy.js";
import { literalInputCommandError } from "./literal-input.js";

// This verifier deliberately recognizes a small fail-closed subset. It trusts
// fixed property reads, direct `input(...)`, and passive console calls. Syntax
// that can hide execution is rejected by category.

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

const SAFE_BINARY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.QuestionQuestionToken
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
  readonly #approvedInputSymbols = new Set<ts.Symbol>();
  readonly #approvedObserveSymbols = new Set<ts.Symbol>();
  readonly #assignedValues = new Map<ts.Symbol, ts.Expression[]>();
  readonly #checker: ts.TypeChecker;
  readonly #issues: StrictSourceIssue[] = [];
  readonly #sourceFile: ts.SourceFile;
  readonly #sourceBindingNames = new Set<string>();

  constructor(sourceFile: ts.SourceFile, checker: ts.TypeChecker) {
    this.#sourceFile = sourceFile;
    this.#checker = checker;
    this.#collectSourceBindingNames(this.#sourceFile);
    this.#collectApprovedCapabilitySymbols();
    this.#collectAssignedValues(this.#sourceFile);
  }

  verify(): StrictSourceIssue[] {
    this.#visit(this.#sourceFile);
    return this.#issues;
  }

  #collectApprovedCapabilitySymbols(): void {
    for (const statement of this.#sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) ||
        !this.#isApprovedCapabilityImport(statement)) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        const symbol = this.#checker.getSymbolAtLocation(binding.name);
        if (!symbol) continue;
        if (binding.name.text === "input") this.#approvedInputSymbols.add(symbol);
        if (binding.name.text === "observe") this.#approvedObserveSymbols.add(symbol);
      }
    }
  }

  #collectSourceBindingNames(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      this.#recordBindingName(node.name);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      if (node.name && ts.isIdentifier(node.name)) {
        this.#sourceBindingNames.add(node.name.text);
      }
    } else if (
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      this.#sourceBindingNames.add(node.name.text);
    } else if (ts.isImportClause(node) && node.name) {
      this.#sourceBindingNames.add(node.name.text);
    }
    ts.forEachChild(node, (child) => this.#collectSourceBindingNames(child));
  }

  #recordBindingName(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) {
      this.#sourceBindingNames.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) this.#recordBindingName(element.name);
    }
  }

  #collectAssignedValues(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = this.#unwrap(node.left);
      if (ts.isIdentifier(target) && this.#isLocalVariable(target)) {
        const symbol = this.#checker.getSymbolAtLocation(target);
        if (symbol) {
          const assignedValues = this.#assignedValues.get(symbol) ?? [];
          assignedValues.push(node.right);
          this.#assignedValues.set(symbol, assignedValues);
        }
      }
    }
    ts.forEachChild(node, (child) => this.#collectAssignedValues(child));
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
      if (call.arguments.length > 1 &&
        !call.arguments.every((argument) =>
          this.#isPrimitiveExpression(argument)
        )) {
        this.#reject(
          call,
          "external-call",
          "Multiple console values must each be a syntax-proven primitive to avoid formatting coercion."
        );
      }
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
    if (ts.isIdentifier(target) && this.#isLocalVariable(target)) return;
    this.#reject(
      node.left,
      "external-write",
      "Only direct assignment to a source-local variable is allowed."
    );
  }

  #checkBinaryOperation(node: ts.BinaryExpression): void {
    if (SAFE_BINARY_OPERATORS.has(node.operatorToken.kind)) return;
    if (IMPLICIT_CALL_BINARY_OPERATORS.has(node.operatorToken.kind)) {
      this.#reject(
        node,
        "external-call",
        "The in and instanceof operators are outside the strict subset."
      );
      return;
    }
    if (this.#isPrimitiveExpression(node.left) &&
      this.#isPrimitiveExpression(node.right)) {
      return;
    }
    this.#reject(
      node,
      "external-call",
      "Coercive operators require operands proven primitive from source syntax."
    );
  }

  #checkUnaryOperation(node: ts.PrefixUnaryExpression): void {
    if (node.operator === ts.SyntaxKind.ExclamationToken) {
      return;
    }
    if (this.#isPrimitiveExpression(node.operand)) return;
    this.#reject(
      node,
      "external-call",
      "Coercive unary operators require an operand proven primitive from source syntax."
    );
  }

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
    if (!ts.isIdentifier(callee)) return false;
    const symbol = this.#checker.getSymbolAtLocation(callee);
    return Boolean(symbol && this.#approvedInputSymbols.has(symbol));
  }

  #checkInputCall(call: ts.CallExpression): void {
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
    const literalError = literalInputCommandError(command);
    if (literalError) {
      this.#reject(call, "external-call", literalError);
    }
  }

  #isApprovedObserveCall(call: ts.CallExpression): boolean {
    const callee = this.#unwrap(call.expression);
    if (!ts.isIdentifier(callee)) return false;
    const symbol = this.#checker.getSymbolAtLocation(callee);
    return Boolean(symbol && this.#approvedObserveSymbols.has(symbol));
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
    const projection = this.#unwrap(call.arguments[0]);
    if (!ts.isObjectLiteralExpression(projection) ||
      projection.properties.length === 0 ||
      projection.properties.length > MAXIMUM_OBSERVATION_FIELDS) {
      return undefined;
    }
    const keys = new Set<string>();
    for (const property of projection.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const key = this.#literalPropertyName(property.name);
      if (!key || FORBIDDEN_OBSERVATION_KEYS.has(key) || keys.has(key)) {
        return undefined;
      }
      if (!this.#isObservationField(property.initializer)) return undefined;
      keys.add(key);
    }
    return keys;
  }

  #isObservationField(expression: ts.Expression): boolean {
    const field = this.#unwrap(expression);
    if (!ts.isObjectLiteralExpression(field) ||
      field.properties.length < 2 || field.properties.length > 4) {
      return false;
    }
    let kindFound = false;
    let nullableFound = false;
    let nullable = false;
    let optionalFound = false;
    let optional = false;
    let pathFound = false;
    for (const property of field.properties) {
      if (!ts.isPropertyAssignment(property)) return false;
      const name = this.#literalPropertyName(property.name);
      if (name === "kind" && !kindFound) {
        const value = this.#unwrap(property.initializer);
        if (!ts.isStringLiteral(value) || !OBSERVATION_KINDS.has(value.text)) {
          return false;
        }
        kindFound = true;
        continue;
      }
      if (name === "nullable" && !nullableFound) {
        const value = this.#unwrap(property.initializer);
        if (value.kind !== ts.SyntaxKind.TrueKeyword &&
          value.kind !== ts.SyntaxKind.FalseKeyword) {
          return false;
        }
        nullableFound = true;
        nullable = value.kind === ts.SyntaxKind.TrueKeyword;
        continue;
      }
      if (name === "optional" && !optionalFound) {
        const value = this.#unwrap(property.initializer);
        if (value.kind !== ts.SyntaxKind.TrueKeyword &&
          value.kind !== ts.SyntaxKind.FalseKeyword) {
          return false;
        }
        optionalFound = true;
        optional = value.kind === ts.SyntaxKind.TrueKeyword;
        continue;
      }
      if (name === "path" && !pathFound) {
        if (!this.#isObservationPath(property.initializer)) return false;
        pathFound = true;
        continue;
      }
      return false;
    }
    return kindFound && pathFound && (!optional || nullable);
  }

  #isObservationPath(expression: ts.Expression): boolean {
    const path = this.#unwrap(expression);
    if (!ts.isArrayLiteralExpression(path) || path.elements.length === 0 ||
      path.elements.length > MAXIMUM_OBSERVATION_PATH_DEPTH) {
      return false;
    }
    return path.elements.every((element) => {
      if (ts.isStringLiteral(element)) {
        return element.text.length > 0 &&
          !FORBIDDEN_OBSERVATION_KEYS.has(element.text);
      }
      return ts.isNumericLiteral(element) &&
        Number.isSafeInteger(Number(element.text)) && Number(element.text) >= 0;
    });
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

  #isPrimitiveExpression(
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
    allowedSelfReference?: ts.Symbol
  ): boolean {
    const value = this.#unwrap(expression);
    if (
      ts.isBigIntLiteral(value) ||
      ts.isNoSubstitutionTemplateLiteral(value) ||
      ts.isNumericLiteral(value) ||
      ts.isStringLiteral(value) ||
      value.kind === ts.SyntaxKind.FalseKeyword ||
      value.kind === ts.SyntaxKind.NullKeyword ||
      value.kind === ts.SyntaxKind.TrueKeyword
    ) {
      return true;
    }
    if (ts.isIdentifier(value)) {
      if (this.#isGlobalPrimitive(value)) return true;
      const symbol = this.#checker.getSymbolAtLocation(value);
      if (!symbol) return false;
      if (seen.has(symbol)) return symbol === allowedSelfReference;
      seen.add(symbol);
      const declarations = symbol.getDeclarations() ?? [];
      if (declarations.length === 0) return false;
      const assignedValues = this.#assignedValues.get(symbol) ?? [];
      return declarations.every((declaration) => {
        if (!ts.isVariableDeclaration(declaration) ||
          !declaration.initializer ||
          !ts.isVariableDeclarationList(declaration.parent)) {
          return false;
        }
        const declarationFlags = declaration.parent.flags;
        const isConstant = (declarationFlags & ts.NodeFlags.Const) !== 0;
        const isBlockScopedVariable = (declarationFlags & ts.NodeFlags.Let) !== 0;
        if (!isConstant && !isBlockScopedVariable) return false;
        if (!this.#isPrimitiveExpression(
          declaration.initializer,
          new Set(seen)
        )) {
          return false;
        }
        if (isConstant) return assignedValues.length === 0;
        return assignedValues.every((assignedValue) =>
          this.#isPrimitiveExpression(assignedValue, new Set(seen), symbol)
        );
      });
    }
    if (this.#isObservedPrimitiveAccess(value)) return true;
    if (ts.isPrefixUnaryExpression(value)) {
      if (value.operator === ts.SyntaxKind.ExclamationToken) {
        return true;
      }
      return this.#isPrimitiveExpression(
        value.operand,
        seen,
        allowedSelfReference
      );
    }
    if (ts.isTypeOfExpression(value) || ts.isVoidExpression(value)) return true;
    if (ts.isBinaryExpression(value)) {
      if (
        value.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        return true;
      }
      return this.#isPrimitiveExpression(
        value.left,
        new Set(seen),
        allowedSelfReference
      ) && this.#isPrimitiveExpression(
        value.right,
        new Set(seen),
        allowedSelfReference
      );
    }
    if (ts.isConditionalExpression(value)) {
      return this.#isPrimitiveExpression(
        value.whenTrue,
        new Set(seen),
        allowedSelfReference
      ) && this.#isPrimitiveExpression(
        value.whenFalse,
        new Set(seen),
        allowedSelfReference
      );
    }
    return false;
  }

  #isObservedPrimitiveAccess(expression: ts.Expression): boolean {
    let receiver: ts.Expression;
    let key: string;
    if (ts.isPropertyAccessExpression(expression)) {
      receiver = this.#unwrap(expression.expression);
      key = expression.name.text;
    } else if (ts.isElementAccessExpression(expression)) {
      receiver = this.#unwrap(expression.expression);
      if (!expression.argumentExpression) return false;
      const argument = this.#unwrap(expression.argumentExpression);
      if (!ts.isStringLiteral(argument) &&
        !ts.isNoSubstitutionTemplateLiteral(argument)) {
        return false;
      }
      key = argument.text;
    } else {
      return false;
    }
    if (ts.isCallExpression(receiver) &&
      this.#isApprovedObserveCall(receiver)) {
      return this.#observationProjectionKeys(receiver)?.has(key) === true;
    }
    if (!ts.isIdentifier(receiver)) return false;
    const symbol = this.#checker.getSymbolAtLocation(receiver);
    const declarations = symbol?.getDeclarations() ?? [];
    if (declarations.length === 0) return false;
    const assignedValues = symbol ? this.#assignedValues.get(symbol) ?? [] : [];
    const declarationsAreProjected = declarations.every((declaration) => {
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer ||
        !ts.isVariableDeclarationList(declaration.parent)) {
        return false;
      }
      const flags = declaration.parent.flags;
      const isConstant = (flags & ts.NodeFlags.Const) !== 0;
      const isBlockScopedVariable = (flags & ts.NodeFlags.Let) !== 0;
      if (!isConstant && !isBlockScopedVariable) {
        return false;
      }
      if (!this.#observationHasKey(declaration.initializer, key)) return false;
      return isBlockScopedVariable || assignedValues.length === 0;
    });
    return declarationsAreProjected && assignedValues.every((assignedValue) =>
      this.#observationHasKey(assignedValue, key)
    );
  }

  #observationHasKey(expression: ts.Expression, key: string): boolean {
    const value = this.#unwrap(expression);
    return ts.isCallExpression(value) &&
      this.#isApprovedObserveCall(value) &&
      this.#observationProjectionKeys(value)?.has(key) === true;
  }

  #isStaticPropertyKey(expression: ts.Expression): boolean {
    const value = this.#unwrap(expression);
    return ts.isBigIntLiteral(value) ||
      ts.isNoSubstitutionTemplateLiteral(value) ||
      ts.isNumericLiteral(value) ||
      ts.isStringLiteral(value);
  }

  #isLocalVariable(identifier: ts.Identifier): boolean {
    const declarations = this.#checker.getSymbolAtLocation(identifier)
      ?.getDeclarations() ?? [];
    return declarations.length > 0 && declarations.every((declaration) =>
      ts.isVariableDeclaration(declaration) && !this.#isAmbient(declaration)
    );
  }

  #isGlobalIdentifier(identifier: ts.Identifier): boolean {
    if (this.#sourceBindingNames.has(identifier.text)) return false;
    const symbol = this.#checker.getSymbolAtLocation(identifier);
    return !symbol || symbol.getDeclarations()?.every(
      (declaration) => declaration.getSourceFile() !== this.#sourceFile
    ) === true;
  }

  #isGlobalPrimitive(identifier: ts.Identifier): boolean {
    return this.#isGlobalIdentifier(identifier) &&
      (identifier.text === "Infinity" ||
        identifier.text === "NaN" ||
        identifier.text === "undefined");
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
  const { checker, program, sourceFile } = createStrictProgram(source, language);
  const parseIssues = program
    .getSyntacticDiagnostics(sourceFile)
    .map((diagnostic) => diagnosticIssue(sourceFile, diagnostic));
  if (parseIssues.length > 0) return { issues: parseIssues, ok: false };

  const issues = new StrictSubsetVerifier(sourceFile, checker).verify();
  return { issues, ok: issues.length === 0 };
}
