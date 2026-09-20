import { parse } from '@babel/parser';

import type { ScannedComponent } from '../../mcp/src/scan/scan.js';

type AstNode = Record<string, any>;

interface PropsResult {
  names: string[];
  extracted: boolean;
}

const UNKNOWN_PROPS: PropsResult = { names: [], extracted: false };
const NO_PROPS: PropsResult = { names: [], extracted: true };
const COMPONENT_WRAPPERS = new Set(['forwardRef', 'memo', 'observer']);
const COMPONENT_TYPE_WRAPPERS = new Set([
  'FC',
  'FunctionComponent',
  'VFC',
  'ComponentType',
  'Component',
  'ParentComponent',
  'VoidComponent',
  'FlowComponent',
]);
const REACT_COMPONENT_BASES = new Set(['Component', 'PureComponent']);
const MAX_WRAPPER_DEPTH = 4;

const isPascalCase = (name: string): boolean => /^[A-Z][A-Za-z0-9]*$/.test(name);

const nameFromFile = (filePath: string): string => {
  const parts = filePath.replaceAll('\\', '/').split('/');
  const file = parts.at(-1) ?? '';
  let base = file.replace(/\.[^.]+$/, '');
  if (base.toLowerCase() === 'index') base = parts.at(-2) ?? base;
  return base
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
};

const parseProgram = (filePath: string, code: string): AstNode | null => {
  try {
    return parse(code, {
      sourceFilename: filePath,
      sourceType: 'unambiguous',
      plugins: ['typescript', 'jsx', 'estree'],
    }).program as unknown as AstNode;
  } catch {
    return null;
  }
};

const declarationOf = (node: AstNode): AstNode | null => {
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
    return (node.declaration as AstNode | null | undefined) ?? null;
  }
  return node;
};

type TypeTable = Map<string, AstNode>;

const collectTypeDeclarations = (program: AstNode): TypeTable => {
  const table: TypeTable = new Map();
  for (const node of program.body ?? []) {
    const declaration = declarationOf(node);
    if (
      declaration?.type !== 'TSInterfaceDeclaration' &&
      declaration?.type !== 'TSTypeAliasDeclaration'
    ) {
      continue;
    }
    if (typeof declaration.id?.name === 'string') table.set(declaration.id.name, declaration);
  }
  return table;
};

const memberNames = (members: AstNode[] = []): string[] =>
  members
    .filter(member => ['TSPropertySignature', 'TSMethodSignature'].includes(member?.type as string))
    .map(member => member.key?.name ?? member.key?.value)
    .filter((name): name is string => typeof name === 'string');

const resolveTypeMembers = (
  node: AstNode | null | undefined,
  table: TypeTable,
  seen: Set<string> = new Set(),
): string[] | null => {
  if (node == null) return null;
  switch (node.type) {
    case 'TSTypeLiteral':
      return memberNames(node.members);
    case 'TSTypeReference': {
      const name = node.typeName?.name;
      if (typeof name !== 'string') return null;
      if (seen.has(name)) return [];
      const declaration = table.get(name);
      return declaration === undefined
        ? null
        : resolveTypeMembers(declaration, table, new Set([...seen, name]));
    }
    case 'TSInterfaceDeclaration': {
      const names = new Set(memberNames(node.body?.body));
      for (const heritage of node.extends ?? []) {
        const inherited = resolveTypeMembers(
          { type: 'TSTypeReference', typeName: heritage.expression },
          table,
          seen,
        );
        if (inherited === null) return null;
        for (const name of inherited) names.add(name);
      }
      return [...names];
    }
    case 'TSTypeAliasDeclaration':
      return resolveTypeMembers(node.typeAnnotation, table, seen);
    case 'TSIntersectionType': {
      const names = new Set<string>();
      for (const part of node.types ?? []) {
        const resolved = resolveTypeMembers(part, table, seen);
        if (resolved === null) return null;
        for (const name of resolved) names.add(name);
      }
      return [...names];
    }
    default:
      return null;
  }
};

const destructuredProps = (parameter: AstNode): { names: string[]; complete: boolean } => {
  if (parameter.type !== 'ObjectPattern') return { names: [], complete: false };
  const names: string[] = [];
  let complete = true;
  for (const property of parameter.properties ?? []) {
    if (property.type === 'RestElement') {
      complete = false;
      continue;
    }
    const name = property.key?.name ?? property.key?.value;
    if (typeof name === 'string') names.push(name);
    else complete = false;
  }
  return { names, complete };
};

const propsOfFunction = (fn: AstNode, table: TypeTable): PropsResult => {
  const parameter = (fn.params?.[0] ?? fn.parameters?.[0]) as AstNode | undefined;
  if (parameter === undefined) return NO_PROPS;
  const destructured = destructuredProps(parameter);
  const annotation = parameter.typeAnnotation?.typeAnnotation;
  if (annotation !== undefined) {
    const names = resolveTypeMembers(annotation, table);
    return names === null
      ? { names: destructured.names, extracted: false }
      : { names, extracted: true };
  }
  return destructured.names.length > 0
    ? { names: destructured.names, extracted: destructured.complete }
    : UNKNOWN_PROPS;
};

const typeParameters = (node: AstNode): AstNode[] =>
  node.typeParameters?.params ?? node.typeArguments?.params ?? [];

const propsFromComponentType = (identifier: AstNode, table: TypeTable): PropsResult | null => {
  const reference = identifier.typeAnnotation?.typeAnnotation;
  if (reference?.type !== 'TSTypeReference') return null;
  const name =
    reference.typeName?.type === 'TSQualifiedName'
      ? reference.typeName.right?.name
      : reference.typeName?.name;
  if (typeof name !== 'string' || !COMPONENT_TYPE_WRAPPERS.has(name)) return null;
  const props = typeParameters(reference)[0];
  if (props === undefined) return null;
  const names = resolveTypeMembers(props, table);
  return names === null ? UNKNOWN_PROPS : { names, extracted: true };
};

/**
 * A declaration file has no initializer to inspect. Its public component can instead be written as
 * `export declare const Icon: (props: IconProps) => JSX.Element` or as a React component type. Keep
 * this separate from the source-file path so ordinary exported constants are not promoted just
 * because they are PascalCase.
 */
const propsFromDeclaredComponent = (identifier: AstNode, table: TypeTable): PropsResult | null => {
  const annotation = identifier.typeAnnotation?.typeAnnotation;
  if (annotation?.type === 'TSFunctionType') return propsOfFunction(annotation, table);
  return propsFromComponentType(identifier, table);
};

const calleeName = (callee: AstNode): string | undefined =>
  callee?.type === 'MemberExpression' ? callee.property?.name : callee?.name;

const functionOf = (node: AstNode | null | undefined, depth = 0): AstNode | null => {
  if (node == null) return null;
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') return node;
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') {
    return functionOf(node.expression, depth);
  }
  if (
    node.type === 'CallExpression' &&
    depth < MAX_WRAPPER_DEPTH &&
    COMPONENT_WRAPPERS.has(calleeName(node.callee) ?? '')
  ) {
    return functionOf(node.arguments?.[0], depth + 1);
  }
  return null;
};

const isReactComponentClass = (node: AstNode): boolean => {
  const parent = node.superClass;
  const name = parent?.type === 'MemberExpression' ? parent.property?.name : parent?.name;
  return typeof name === 'string' && REACT_COMPONENT_BASES.has(name);
};

const propsOfClass = (node: AstNode, table: TypeTable): PropsResult => {
  const props = (node.superTypeParameters?.params ?? node.superTypeArguments?.params ?? [])[0];
  if (props === undefined) return UNKNOWN_PROPS;
  const names = resolveTypeMembers(props, table);
  return names === null ? UNKNOWN_PROPS : { names, extracted: true };
};

interface Candidate {
  name: string | null;
  props: PropsResult;
}

const candidatesOfDeclaration = (node: AstNode, table: TypeTable): Candidate[] => {
  if (node.type === 'FunctionDeclaration') {
    return [{ name: node.id?.name ?? null, props: propsOfFunction(node, table) }];
  }
  if (node.type === 'ClassDeclaration' && isReactComponentClass(node)) {
    return [{ name: node.id?.name ?? null, props: propsOfClass(node, table) }];
  }
  if (node.type !== 'VariableDeclaration') {
    const fn = functionOf(node);
    return fn === null ? [] : [{ name: null, props: propsOfFunction(fn, table) }];
  }
  return (node.declarations ?? []).flatMap((declaration: AstNode) => {
    const fn = functionOf(declaration.init);
    if (fn === null) {
      const declared = propsFromDeclaredComponent(declaration.id, table);
      return declared === null ? [] : [{ name: declaration.id?.name ?? null, props: declared }];
    }
    const typed = propsFromComponentType(declaration.id, table);
    const fromFunction = propsOfFunction(fn, table);
    return [
      {
        name: declaration.id?.name ?? null,
        props:
          typed === null
            ? fromFunction
            : typed.extracted
              ? typed
              : { names: fromFunction.names, extracted: false },
      },
    ];
  });
};

const collectLocalDeclarations = (program: AstNode): Map<string, AstNode> => {
  const declarations = new Map<string, AstNode>();
  for (const node of program.body ?? []) {
    const declaration = declarationOf(node);
    if (declaration === null) continue;
    if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
      if (typeof declaration.id?.name === 'string')
        declarations.set(declaration.id.name, declaration);
    } else if (declaration.type === 'VariableDeclaration') {
      for (const value of declaration.declarations ?? []) {
        if (typeof value.id?.name === 'string') {
          declarations.set(value.id.name, { type: 'VariableDeclaration', declarations: [value] });
        }
      }
    }
  }
  return declarations;
};

/**
 * Statically read exported React component names and their locally-provable prop contracts. `null`
 * means the file could not be parsed, allowing the caller to retain its name-only fallback.
 */
export const extractPortableReactComponents = (
  filePath: string,
  code: string,
): ScannedComponent[] | null => {
  const program = parseProgram(filePath, code);
  if (program === null) return null;
  const types = collectTypeDeclarations(program);
  const locals = collectLocalDeclarations(program);
  const components = new Map<string, ScannedComponent>();

  const add = (candidate: Candidate, exportKind: 'default' | 'named'): void => {
    const name = candidate.name ?? (exportKind === 'default' ? nameFromFile(filePath) : '');
    if (!isPascalCase(name) || components.has(name)) return;
    components.set(name, {
      name,
      filePath,
      exportKind,
      propNames: candidate.props.names,
      propsExtracted: candidate.props.extracted,
      framework: 'react',
    });
  };

  for (const node of program.body ?? []) {
    if (node.type !== 'ExportNamedDeclaration' && node.type !== 'ExportDefaultDeclaration')
      continue;
    const exportKind = node.type === 'ExportDefaultDeclaration' ? 'default' : 'named';
    if (node.declaration != null) {
      for (const candidate of candidatesOfDeclaration(node.declaration, types))
        add(candidate, exportKind);
    }
    if (node.type === 'ExportDefaultDeclaration' && node.declaration?.type === 'Identifier') {
      const local = locals.get(node.declaration.name);
      if (local !== undefined) {
        for (const candidate of candidatesOfDeclaration(local, types)) add(candidate, 'default');
      }
    }
    if (node.type === 'ExportNamedDeclaration' && node.source == null) {
      for (const specifier of node.specifiers ?? []) {
        const localName = specifier.local?.name;
        if (typeof localName !== 'string') continue;
        const local = locals.get(localName);
        if (local !== undefined) {
          for (const candidate of candidatesOfDeclaration(local, types)) add(candidate, 'named');
        }
      }
    }
  }
  return [...components.values()];
};
