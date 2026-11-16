// graphql.ts — a focused GraphQL executor for the documents gh and
// github-mcp-server send: a tokenizer, a recursive-descent parser for the query
// language subset in play, and an executor over the shared store with static
// field maps per type (which double as the introspection source). Batching
// (a JSON array body) answers one result per operation, in order.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  globalId,
  parseGlobalId,
  type IssueRecord,
  type PullRecord,
  type RepoState,
} from './store.ts';
import { addComment, createIssue, createPull, mergeConflicts, mergeContext, pullRequestFiles, squashMerge } from './ops.ts';
import type { RequestContext } from './app.ts';
import { sendError, sendJson } from './app.ts';

// ---------------------------------------------------------------- tokenizer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['{', '}', '(', ')', ':', '!', '$', '=', '@', '[', ']', '|', '&']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      push('punct', '...');
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      push('punct', ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source[i + 1] === '"' && source[i + 2] === '"') {
        // A block string: dedented, per the spec's BlockStringValue.
        let j = i + 3;
        while (j < source.length && !(source[j] === '"' && source[j + 1] === '"' && source[j + 2] === '"')) j += 1;
        if (j >= source.length) throw new Error('unterminated block string');
        push('string', dedentBlockString(source.slice(i + 3, j)));
        i = j + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else if (esc !== undefined) value += esc;
          j += 2;
          continue;
        }
        value += source[j];
        j += 1;
      }
      if (j >= source.length) throw new Error('unterminated string');
      push('string', value);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      push(isFloat ? 'float' : 'int', source.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j]!)) j += 1;
      push('name', source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in document`);
  }
  push('eof', '');
  return tokens;
}

function dedentBlockString(raw: string): string {
  const lines = raw.split('\n');
  let common = Number.POSITIVE_INFINITY;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent < common) common = indent;
  }
  if (common === Number.POSITIVE_INFINITY) common = 0;
  const out = lines.map((line, index) => (index === 0 ? line : line.slice(common)));
  while (out.length > 0 && out[0]?.trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1]?.trim() === '') out.pop();
  return out.join('\n');
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface DirectiveNode {
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
}

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
  directives: DirectiveNode[];
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface VariableDefinition {
  name: string;
  defaultValue: ValueNode | null;
}

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDefinition[];
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}", got "${token.value}"`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got "${token.value}"`);
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}", got "${token.value}"`);
    return token.value;
  }

  private acceptName(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'name' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.parseDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.expectName();
      const variables = this.parseVariableDefinitions();
      this.parseDirectives();
      return { kind: 'operation', operation, name, variables, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected definition start "${token.value}"`);
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const variables: VariableDefinition[] = [];
    if (!this.acceptPunct('(')) return variables;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      this.parseDirectives();
      variables.push({ name, defaultValue });
    }
    return variables;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.acceptPunct('...')) {
      if (this.peek().kind === 'name' && this.peek().value !== 'on') {
        const name = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'fragmentSpread', name, directives };
      }
      let typeCondition: string | null = null;
      if (this.acceptName('on')) typeCondition = this.expectName();
      const directives = this.parseDirectives();
      return { kind: 'inlineFragment', typeCondition, directives, selectionSet: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.acceptPunct('@')) {
      const name = this.expectName();
      directives.push({ name, args: this.parseArguments() });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token "${token.value}"`);
  }
}

// ---------------------------------------------------------------- values

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function valueFromNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueFromNode(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

function argsFromNodes(nodes: Array<{ name: string; value: ValueNode }>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of nodes) out[arg.name] = valueFromNode(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- the schema's field maps

/** A resolved object: its GraphQL type plus the store record behind it. */
interface GqlObject {
  __typename: string;
  __source: unknown;
}

function obj(typename: string, source: unknown): GqlObject {
  return { __typename: typename, __source: source };
}

type Resolver = (source: unknown, args: Record<string, unknown>, exec: Executor) => unknown;

const FIELDS: Record<string, Record<string, Resolver>> = {};

function defineFields(type: string, fields: Record<string, Resolver>): void {
  FIELDS[type] = fields;
}

/** The static field list introspection reports for a type (the resolvers it holds). */
function fieldNamesOf(type: string): string[] {
  return Object.keys(FIELDS[type] ?? {});
}

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const TYPE_KINDS: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  Repository: 'OBJECT',
  User: 'OBJECT',
  Ref: 'OBJECT',
  Issue: 'OBJECT',
  IssueConnection: 'OBJECT',
  IssueEdge: 'OBJECT',
  PageInfo: 'OBJECT',
  PullRequest: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  IssueCommentEdge: 'OBJECT',
  IssueComment: 'OBJECT',
  Node: 'INTERFACE',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  RepositoryPermission: 'ENUM',
  OrderDirection: 'ENUM',
  IssueOrderField: 'ENUM',
  MergeMethod: 'ENUM',
  CreateIssueInput: 'INPUT_OBJECT',
  CloseIssueInput: 'INPUT_OBJECT',
  CreatePullRequestInput: 'INPUT_OBJECT',
  MergePullRequestInput: 'INPUT_OBJECT',
  AddCommentInput: 'INPUT_OBJECT',
  IssueOrder: 'INPUT_OBJECT',
  String: 'SCALAR',
  Int: 'SCALAR',
  Boolean: 'SCALAR',
  ID: 'SCALAR',
};

// ---------------------------------------------------------------- cursor pagination

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the executor

class Executor {
  readonly errors: Array<{ message: string }> = [];
  private readonly fragments = new Map<string, FragmentNode>();
  readonly ctx: RequestContext;
  private readonly variables: Record<string, unknown>;

  constructor(ctx: RequestContext, variables: Record<string, unknown>) {
    this.ctx = ctx;
    this.variables = variables;
  }

  execute(document: DefinitionNode[], operationName: string | undefined): Record<string, unknown> | null {
    for (const definition of document) {
      if (definition.kind === 'fragment') this.fragments.set(definition.name, definition);
    }
    const operations = document.filter((d): d is OperationNode => d.kind === 'operation');
    let operation: OperationNode | undefined;
    if (operationName !== undefined) {
      operation = operations.find((op) => op.name === operationName);
      if (operation === undefined) {
        this.errors.push({ message: `unknown operation named "${operationName}"` });
        return null;
      }
    } else if (operations.length === 1) {
      operation = operations[0];
    } else if (operations.length === 0) {
      this.errors.push({ message: 'the document holds no operation' });
      return null;
    } else {
      this.errors.push({ message: 'the document holds several operations; operationName is required' });
      return null;
    }
    if (operation.operation === 'subscription') {
      this.errors.push({ message: 'subscriptions are not supported' });
      return null;
    }
    // Variable defaults fill what the caller did not send.
    const variables: Record<string, unknown> = { ...this.variables };
    for (const variable of operation.variables) {
      if (variables[variable.name] === undefined && variable.defaultValue !== null) {
        variables[variable.name] = valueFromNode(variable.defaultValue, variables);
      }
    }
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = this.executeSelectionSet(operation.selectionSet, obj(rootType, null), variables);
    return data as Record<string, unknown>;
  }

  private directivesAllow(directives: readonly DirectiveNode[], variables: Record<string, unknown>): boolean {
    for (const directive of directives) {
      const args = argsFromNodes(directive.args, variables);
      if (directive.name === 'skip' && args.if === true) return false;
      if (directive.name === 'include' && args.if === false) return false;
    }
    return true;
  }

  private collectFields(
    selections: readonly SelectionNode[],
    typename: string,
    variables: Record<string, unknown>,
    out: FieldNode[] = [],
    seenFragments = new Set<string>(),
  ): FieldNode[] {
    for (const selection of selections) {
      if (!this.directivesAllow(selection.directives ?? [], variables)) continue;
      if (selection.kind === 'field') {
        out.push(selection);
      } else if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition === null || selection.typeCondition === typename) {
          this.collectFields(selection.selectionSet, typename, variables, out, seenFragments);
        }
      } else {
        if (seenFragments.has(selection.name)) continue;
        seenFragments.add(selection.name);
        const fragment = this.fragments.get(selection.name);
        if (fragment !== undefined && fragment.typeCondition === typename) {
          this.collectFields(fragment.selectionSet, typename, variables, out, seenFragments);
        }
      }
    }
    return out;
  }

  private executeSelectionSet(selections: readonly SelectionNode[], object: GqlObject, variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const fields = this.collectFields(selections, object.__typename, variables);
    for (const field of fields) {
      const key = field.alias ?? field.name;
      out[key] = this.executeField(field, object, variables);
    }
    return out;
  }

  private executeField(field: FieldNode, object: GqlObject, variables: Record<string, unknown>): unknown {
    const typename = object.__typename;
    if (field.name === '__typename') return typename;
    const resolver = FIELDS[typename]?.[field.name];
    if (resolver === undefined) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typename}".` });
      return null;
    }
    const args = argsFromNodes(field.args, variables);
    let value: unknown;
    try {
      value = resolver(object.__source, args, this);
    } catch (error) {
      this.errors.push({ message: error instanceof Error ? error.message : String(error) });
      return null;
    }
    if (value === null || value === undefined) return null;
    if (field.selectionSet === null) {
      // A leaf: scalars pass through; an object without a selection set is an error
      // in GraphQL, but no document the suite sends does that.
      if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        this.errors.push({ message: `field "${field.name}" of type "${typename}" must have a selection of subfields` });
        return null;
      }
      return value as JsonValue;
    }
    if (Array.isArray(value)) {
      return value.map((entry) =>
        entry !== null && typeof entry === 'object' && '__typename' in (entry as Record<string, unknown>)
          ? this.executeSelectionSet(field.selectionSet!, entry as GqlObject, variables)
          : entry,
      );
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      return this.executeSelectionSet(field.selectionSet, value as GqlObject, variables);
    }
    return value as JsonValue;
  }
}

// ---------------------------------------------------------------- helpers for resolvers

function repoById(exec: Executor, id: unknown): RepoState | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  const [owner, name] = parsed.key.split('/');
  if (owner === undefined || name === undefined) return null;
  return exec.ctx.store.getRepo(owner, name) ?? null;
}

function issueByGlobalId(exec: Executor, id: unknown): { repo: RepoState; issue: IssueRecord } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return null;
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(parsed.key);
  if (match === null) return null;
  const repo = exec.ctx.store.getRepo(match[1]!, match[2]!);
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(match[3]));
  return issue === undefined ? null : { repo, issue };
}

function pullByGlobalId(exec: Executor, id: unknown): { repo: RepoState; pull: PullRecord } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(parsed.key);
  if (match === null) return null;
  const repo = exec.ctx.store.getRepo(match[1]!, match[2]!);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number(match[3]));
  return pull === undefined ? null : { repo, pull };
}

function repoObject(repo: RepoState): GqlObject {
  return obj('Repository', repo);
}

function issueObject(repo: RepoState, issue: IssueRecord): GqlObject {
  return obj('Issue', { repo, issue });
}

function pullObject(repo: RepoState, pull: PullRecord): GqlObject {
  return obj('PullRequest', { repo, pull });
}

// ---------------------------------------------------------------- field definitions

defineFields('Query', {
  viewer: () => obj('User', null),
  repository: (_source, args, exec) => {
    const owner = args.owner;
    const name = args.name;
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    const repo = exec.ctx.store.getRepo(owner, name);
    return repo === undefined ? null : repoObject(repo);
  },
  node: (_source, args, exec) => {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (parsed === null) return null;
    if (parsed.type === 'Repository') {
      const repo = repoById(exec, id);
      return repo === null ? null : repoObject(repo);
    }
    if (parsed.type === 'Issue') {
      const found = issueByGlobalId(exec, id);
      return found === null ? null : issueObject(found.repo, found.issue);
    }
    if (parsed.type === 'PullRequest') {
      const found = pullByGlobalId(exec, id);
      return found === null ? null : pullObject(found.repo, found.pull);
    }
    return null;
  },
  __type: (_source, args) => {
    const name = args.name;
    if (typeof name !== 'string') return null;
    if (TYPE_KINDS[name] === undefined) return null;
    return obj('__Type', name);
  },
});

defineFields('Mutation', {
  createIssue: (_source, args, exec) => {
    const input = args.input as Record<string, unknown> | undefined;
    if (input === undefined) throw new Error('createIssue needs an input object');
    const repo = repoById(exec, input.repositoryId);
    if (repo === null) throw new Error('createIssue names an unknown repository');
    const created = createIssue(exec.ctx.store, repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
    if ('error' in created) throw new Error(created.error);
    return obj('CreateIssuePayload', { repo, issue: created.issue });
  },
  closeIssue: (_source, args, exec) => {
    const input = args.input as Record<string, unknown> | undefined;
    if (input === undefined) throw new Error('closeIssue needs an input object');
    const found = issueByGlobalId(exec, input.issueId);
    if (found === null) throw new Error('closeIssue names an unknown issue');
    found.issue.state = 'closed';
    return obj('CloseIssuePayload', { repo: found.repo, issue: found.issue });
  },
  createPullRequest: (_source, args, exec) => {
    const input = args.input as Record<string, unknown> | undefined;
    if (input === undefined) throw new Error('createPullRequest needs an input object');
    const repo = repoById(exec, input.repositoryId);
    if (repo === null) throw new Error('createPullRequest names an unknown repository');
    const created = createPull(
      exec.ctx.store,
      repo,
      String(input.headRefName ?? ''),
      String(input.baseRefName ?? ''),
      String(input.title ?? ''),
      typeof input.body === 'string' ? input.body : '',
    );
    if ('error' in created) throw new Error(created.error);
    return obj('CreatePullRequestPayload', { repo, pull: created.pull });
  },
  mergePullRequest: (_source, args, exec) => {
    const input = args.input as Record<string, unknown> | undefined;
    if (input === undefined) throw new Error('mergePullRequest needs an input object');
    const found = pullByGlobalId(exec, input.pullRequestId);
    if (found === null) throw new Error('mergePullRequest names an unknown pull request');
    const outcome = squashMerge(found.repo, found.pull);
    if (!outcome.ok) throw new Error(outcome.reason === 'conflict' ? 'the pull request has a merge conflict' : 'the pull request cannot be merged');
    return obj('MergePullRequestPayload', { repo: found.repo, pull: found.pull });
  },
  addComment: (_source, args, exec) => {
    const input = args.input as Record<string, unknown> | undefined;
    if (input === undefined) throw new Error('addComment needs an input object');
    const body = typeof input.body === 'string' ? input.body : '';
    const asIssue = issueByGlobalId(exec, input.subjectId);
    if (asIssue !== null) {
      const comment = addComment(exec.ctx.store, asIssue.issue, body);
      return obj('AddCommentPayload', { repo: asIssue.repo, number: asIssue.issue.number, comment });
    }
    const asPull = pullByGlobalId(exec, input.subjectId);
    if (asPull !== null) {
      const comment = addComment(exec.ctx.store, asPull.pull, body);
      return obj('AddCommentPayload', { repo: asPull.repo, number: asPull.pull.number, comment });
    }
    throw new Error('addComment names an unknown subject');
  },
});

defineFields('Repository', {
  id: (source) => globalId('Repository', `${(source as RepoState).owner}/${(source as RepoState).name}`),
  databaseId: (source) => (source as RepoState).id,
  name: (source) => (source as RepoState).name,
  nameWithOwner: (source) => `${(source as RepoState).owner}/${(source as RepoState).name}`,
  owner: () => obj('User', null),
  defaultBranchRef: (source) => obj('Ref', { name: (source as RepoState).defaultBranch }),
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  issue: (source, args) => {
    const repo = source as RepoState;
    const number = args.number;
    if (typeof number !== 'number') return null;
    const issue = repo.issues.get(number);
    return issue === undefined ? null : issueObject(repo, issue);
  },
  issues: (source, args) => {
    const repo = source as RepoState;
    let issues = [...repo.issues.values()];
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state).toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = args.orderBy as Record<string, unknown> | undefined;
    const descending = orderBy !== undefined && String(orderBy.direction ?? '') === 'DESC';
    issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
    const after = decodeCursor(args.after);
    if (after !== null) {
      issues = issues.filter((issue) => (descending ? issue.number < after : issue.number > after));
    }
    const first = typeof args.first === 'number' ? args.first : issues.length;
    const page = issues.slice(0, Math.max(0, first));
    const hasNextPage = issues.length > page.length;
    const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
    return obj('IssueConnection', { items: page, repo, hasNextPage, endCursor });
  },
  pullRequests: (source, args) => {
    const repo = source as RepoState;
    let pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
    pulls.sort((a, b) => a.number - b.number);
    const first = typeof args.first === 'number' ? args.first : pulls.length;
    return obj('PullRequestConnection', { items: pulls.slice(0, Math.max(0, first)), repo });
  },
  pullRequest: (source, args) => {
    const repo = source as RepoState;
    const number = args.number;
    if (typeof number !== 'number') return null;
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullObject(repo, pull);
  },
});

defineFields('User', {
  login: () => VIEWER_LOGIN,
  id: () => globalId('User', VIEWER_LOGIN),
});

defineFields('Ref', {
  name: (source) => (source as { name: string }).name,
  id: (source) => globalId('Ref', (source as { name: string }).name),
});

defineFields('Issue', {
  id: (source) => {
    const { repo, issue } = source as { repo: RepoState; issue: IssueRecord };
    return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
  },
  number: (source) => (source as { issue: IssueRecord }).issue.number,
  title: (source) => (source as { issue: IssueRecord }).issue.title,
  state: (source) => ((source as { issue: IssueRecord }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
  body: (source) => (source as { issue: IssueRecord }).issue.body,
});

defineFields('IssueConnection', {
  nodes: (source) => {
    const { items, repo } = source as { items: IssueRecord[]; repo: RepoState };
    return items.map((issue) => issueObject(repo, issue));
  },
  edges: (source) => {
    const { items, repo } = source as { items: IssueRecord[]; repo: RepoState };
    return items.map((issue) => obj('IssueEdge', { repo, issue }));
  },
  pageInfo: (source) => {
    const { hasNextPage, endCursor, items } = source as { hasNextPage: boolean; endCursor: string | null; items: IssueRecord[] };
    return obj('PageInfo', {
      hasNextPage,
      hasPreviousPage: false,
      startCursor: items.length > 0 ? encodeCursor(items[0]!.number) : null,
      endCursor,
    });
  },
  totalCount: (source) => (source as { items: IssueRecord[] }).items.length,
});

defineFields('IssueEdge', {
  node: (source) => {
    const { repo, issue } = source as { repo: RepoState; issue: IssueRecord };
    return issueObject(repo, issue);
  },
  cursor: (source) => encodeCursor((source as { issue: IssueRecord }).issue.number),
});

defineFields('PageInfo', {
  hasNextPage: (source) => (source as { hasNextPage: boolean }).hasNextPage,
  hasPreviousPage: (source) => (source as { hasPreviousPage: boolean }).hasPreviousPage,
  startCursor: (source) => (source as { startCursor: string | null }).startCursor,
  endCursor: (source) => (source as { endCursor: string | null }).endCursor,
});

defineFields('PullRequest', {
  id: (source) => {
    const { repo, pull } = source as { repo: RepoState; pull: PullRecord };
    return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
  },
  number: (source) => (source as { pull: PullRecord }).pull.number,
  title: (source) => (source as { pull: PullRecord }).pull.title,
  body: (source) => (source as { pull: PullRecord }).pull.body,
  state: (source) => {
    const pull = (source as { pull: PullRecord }).pull;
    if (pull.merged) return 'MERGED';
    return pull.state === 'open' ? 'OPEN' : 'CLOSED';
  },
  merged: (source) => (source as { pull: PullRecord }).pull.merged,
  headRefName: (source) => (source as { pull: PullRecord }).pull.headRef,
  baseRefName: (source) => (source as { pull: PullRecord }).pull.baseRef,
  mergeable: (source) => {
    const { repo, pull } = source as { repo: RepoState; pull: PullRecord };
    if (pull.state !== 'open') return 'UNKNOWN';
    const context = mergeContext(repo, pull);
    if (context === null) return 'UNKNOWN';
    return mergeConflicts(repo, context) ? 'CONFLICTING' : 'MERGEABLE';
  },
  files: (source, args) => {
    const { repo, pull } = source as { repo: RepoState; pull: PullRecord };
    const changes = pullRequestFiles(repo, pull);
    const first = typeof args.first === 'number' ? args.first : changes.length;
    return obj('PullRequestChangedFileConnection', { items: changes.slice(0, Math.max(0, first)) });
  },
});

defineFields('PullRequestConnection', {
  nodes: (source) => {
    const { items, repo } = source as { items: PullRecord[]; repo: RepoState };
    return items.map((pull) => pullObject(repo, pull));
  },
  edges: (source) => {
    const { items, repo } = source as { items: PullRecord[]; repo: RepoState };
    return items.map((pull) => obj('PullRequestEdge', { repo, pull }));
  },
  pageInfo: (source) =>
    obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
  totalCount: (source) => (source as { items: PullRecord[] }).items.length,
});

defineFields('PullRequestEdge', {
  node: (source) => {
    const { repo, pull } = source as { repo: RepoState; pull: PullRecord };
    return pullObject(repo, pull);
  },
  cursor: () => null,
});

defineFields('PullRequestChangedFileConnection', {
  nodes: (source) =>
    (source as { items: Array<{ path: string; status: string; additions: number; deletions: number }> }).items.map((change) =>
      obj('PullRequestChangedFile', change),
    ),
  pageInfo: () => obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
});

defineFields('PullRequestChangedFile', {
  path: (source) => (source as { path: string }).path,
  additions: (source) => (source as { additions: number }).additions,
  deletions: (source) => (source as { deletions: number }).deletions,
  changeType: (source) => {
    const status = (source as { status: string }).status;
    return status === 'added' ? 'ADDED' : status === 'removed' ? 'REMOVED' : 'MODIFIED';
  },
});

defineFields('CreateIssuePayload', {
  issue: (source) => {
    const { repo, issue } = source as { repo: RepoState; issue: IssueRecord };
    return issueObject(repo, issue);
  },
  clientMutationId: () => null,
});

defineFields('CloseIssuePayload', {
  issue: (source) => {
    const { repo, issue } = source as { repo: RepoState; issue: IssueRecord };
    return issueObject(repo, issue);
  },
  clientMutationId: () => null,
});

defineFields('CreatePullRequestPayload', {
  pullRequest: (source) => {
    const { repo, pull } = source as { repo: RepoState; pull: PullRecord };
    return pullObject(repo, pull);
  },
  clientMutationId: () => null,
});

defineFields('MergePullRequestPayload', {
  pullRequest: (source) => {
    const { repo, pull } = source as { repo: RepoState; pull: PullRecord };
    return pullObject(repo, pull);
  },
  clientMutationId: () => null,
});

defineFields('AddCommentPayload', {
  commentEdge: (source) => obj('IssueCommentEdge', source),
  clientMutationId: () => null,
});

defineFields('IssueCommentEdge', {
  node: (source) => obj('IssueComment', source),
  cursor: () => null,
});

defineFields('IssueComment', {
  id: (source) => {
    const { repo, number, comment } = source as { repo: RepoState; number: number; comment: { id: number } };
    return globalId('IssueComment', `${repo.owner}/${repo.name}#${number}/c${comment.id}`);
  },
  body: (source) => (source as { comment: { body: string } }).comment.body,
});

defineFields('__Type', {
  name: (source) => source as string,
  kind: (source) => TYPE_KINDS[source as string] ?? 'OBJECT',
  description: () => null,
  fields: (source) => fieldNamesOf(source as string).map((name) => obj('__Field', name)),
  enumValues: (source) => (ENUM_VALUES[source as string] ?? []).map((name) => obj('__EnumValue', name)),
});

defineFields('__Field', {
  name: (source) => source as string,
  description: () => null,
});

defineFields('__EnumValue', {
  name: (source) => source as string,
  description: () => null,
});

// ---------------------------------------------------------------- the endpoint

interface OperationRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOperation(ctx: RequestContext, request: OperationRequest): Record<string, unknown> {
  const query = request.query;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'the request carries no query string' }] };
  }
  const variables =
    request.variables !== undefined && typeof request.variables === 'object' && request.variables !== null && !Array.isArray(request.variables)
      ? (request.variables as Record<string, unknown>)
      : {};
  const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
  let document: DefinitionNode[];
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const executor = new Executor(ctx, variables);
  const data = executor.execute(document, operationName);
  const result: Record<string, unknown> = { data };
  if (executor.errors.length > 0) result.errors = executor.errors;
  return result;
}

export async function handleGraphQLRequest(
  ctx: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 404, 'not found');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'malformed JSON body' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    // Operation batching: one result per operation, in request order.
    const results = parsed.map((entry) =>
      typeof entry === 'object' && entry !== null ? executeOperation(ctx, entry as OperationRequest) : { data: null, errors: [{ message: 'a batched entry is not an object' }] },
    );
    sendJson(res, 200, results);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { errors: [{ message: 'the body is not an operation object' }] });
    return;
  }
  sendJson(res, 200, executeOperation(ctx, parsed as OperationRequest));
}
