#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const protectedPaths = new Set([
  'Array',
  'Array.isArray',
  'Array.prototype',
  'Array.prototype.filter',
  'JSON',
  'JSON.parse',
  'Number',
  'Number.isSafeInteger',
  'Object',
  'Object.freeze',
  'Object.isFrozen',
  'Object.values',
  'Object.prototype',
  'Object.prototype.hasOwnProperty',
  'Object.prototype.hasOwnProperty.call',
  'Reflect',
  'fs',
  'fs.readFileSync',
  'fs.statSync',
  'candidateOutcomeSnapshotReady',
  'candidateOutcomeSnapshotsTerminalAndStable',
  'deepFreezeDiagnosticsSnapshot',
  'readDiagnosticsPeerSnapshot',
  'waitForDiagnosticsPeerSnapshot'
]);
const mutatorCalls = new Set([
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.setPrototypeOf',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.set',
  'Reflect.setPrototypeOf'
]);
const globalRoots = new Set(['global', 'globalThis']);
const pureCandidatePredicateNames = new Set([
  'candidateOutcomeSnapshotReady',
  'candidateOutcomeSnapshotsTerminalAndStable'
]);

function walk(node, visitor) {
  if (!node || typeof node.type !== 'string') return;
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visitor);
    } else {
      walk(value, visitor);
    }
  }
}

function propertyName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return '';
}

function candidateEvidenceIntrinsicViolations(source) {
  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true,
      locations: true
    });
  } catch (error) {
    return [`parse=${error.message}`];
  }

  const aliases = new Map();

  function isProtected(memberPath) {
    if (!memberPath) return false;
    for (const protectedPath of protectedPaths) {
      if (memberPath === protectedPath || protectedPath.startsWith(`${memberPath}.`)) {
        return true;
      }
    }
    return false;
  }

  function isTrackedAliasSource(memberPath) {
    return memberPath === '<global>' || isProtected(memberPath) || mutatorCalls.has(memberPath);
  }

  function memberPath(node) {
    if (!node) return '';
    if (node.type === 'ChainExpression') return memberPath(node.expression);
    if (node.type === 'Identifier') {
      if (aliases.has(node.name)) return aliases.get(node.name);
      if (globalRoots.has(node.name)) return '<global>';
      return node.name;
    }
    if (node.type !== 'MemberExpression') return '';
    const owner = memberPath(node.object);
    if (!owner) return '';
    const property = !node.computed
      ? propertyName(node.property)
      : propertyName(node.property);
    if (!property) return '';
    return owner === '<global>' ? property : `${owner}.${property}`;
  }

  function bindAlias(pattern, sourcePath) {
    if (!pattern || !isTrackedAliasSource(sourcePath)) return false;
    if (pattern.type === 'AssignmentPattern') {
      return bindAlias(pattern.left, sourcePath);
    }
    if (pattern.type === 'Identifier') {
      if (aliases.get(pattern.name) === sourcePath) return false;
      aliases.set(pattern.name, sourcePath);
      return true;
    }
    if (pattern.type !== 'ObjectPattern') return false;

    let changed = false;
    for (const property of pattern.properties) {
      if (property.type !== 'Property' || property.computed) continue;
      const name = propertyName(property.key);
      if (!name) continue;
      const propertyPath = sourcePath === '<global>'
        ? name
        : `${sourcePath}.${name}`;
      if (bindAlias(property.value, propertyPath)) changed = true;
    }
    return changed;
  }

  let changed = true;
  while (changed) {
    changed = false;
    walk(ast, (node) => {
      if (node.type === 'VariableDeclarator' && node.init) {
        if (bindAlias(node.id, memberPath(node.init))) changed = true;
      } else if (node.type === 'AssignmentExpression' && node.operator === '=') {
        if (bindAlias(node.left, memberPath(node.right))) changed = true;
      }
    });
  }

  function mutationTargetPath(node) {
    if (!node) return '';
    // Assigning a protected object to a local alias is not itself a mutation
    // of that object. Member writes through that alias remain violations.
    if (node.type === 'Identifier') return node.name;
    return memberPath(node);
  }

  const violations = [];
  const addViolation = (node, detail) => {
    violations.push(`line=${node.loc.start.line} ${detail}`);
  };

  walk(ast, (node) => {
    if (node.type === 'AssignmentExpression') {
      const target = mutationTargetPath(node.left);
      if (isProtected(target) || mutatorCalls.has(target)) {
        addViolation(node, `assignment=${target}`);
      }
    } else if (node.type === 'UpdateExpression') {
      const target = mutationTargetPath(node.argument);
      if (isProtected(target) || mutatorCalls.has(target)) {
        addViolation(node, `update=${target}`);
      }
    } else if (node.type === 'UnaryExpression' && node.operator === 'delete') {
      const target = mutationTargetPath(node.argument);
      if (isProtected(target) || mutatorCalls.has(target)) {
        addViolation(node, `delete=${target}`);
      }
    } else if (node.type === 'CallExpression') {
      const calleePath = memberPath(node.callee);
      const targetPath = memberPath(node.arguments[0]);
      if (mutatorCalls.has(calleePath) && isProtected(targetPath)) {
        addViolation(node, `mutator=${calleePath} target=${targetPath}`);
      } else if (calleePath.endsWith('.__defineGetter__') ||
          calleePath.endsWith('.__defineSetter__')) {
        const ownerPath = calleePath.replace(/\.__define(?:Getter|Setter)__$/, '');
        if (isProtected(ownerPath)) addViolation(node, `legacy-mutator=${calleePath}`);
      }
    }
  });

  // Candidate verdict predicates receive recursively frozen evidence. Keep
  // those predicates structurally pure as well: a write or mutator hidden in
  // a boolean expression would otherwise turn a measurement into an action
  // and make the static policy depend on whether strict-mode throws at run
  // time. Nested closures are included so alias/IIFE spellings cannot evade
  // the same rule.
  walk(ast, (node) => {
    if (node.type !== 'FunctionDeclaration' ||
        !node.id ||
        !pureCandidatePredicateNames.has(node.id.name)) {
      return;
    }
    walk(node.body, (predicateNode) => {
      if (predicateNode.type === 'AssignmentExpression' ||
          predicateNode.type === 'UpdateExpression' ||
          (predicateNode.type === 'UnaryExpression' &&
            predicateNode.operator === 'delete')) {
        addViolation(
          predicateNode,
          `impure-predicate=${node.id.name} node=${predicateNode.type}`);
        return;
      }
      if (predicateNode.type !== 'CallExpression') return;
      const calleePath = memberPath(predicateNode.callee);
      if (mutatorCalls.has(calleePath) ||
          calleePath.endsWith('.__defineGetter__') ||
          calleePath.endsWith('.__defineSetter__')) {
        addViolation(
          predicateNode,
          `impure-predicate=${node.id.name} call=${calleePath}`);
      }
    });
  });

  return violations;
}

function runCli(argv) {
  const targetPath = argv[2] ? path.resolve(argv[2]) : '';
  if (!targetPath || !fs.existsSync(targetPath)) {
    console.error('[CANDIDATE-INTRINSIC-POLICY] target JavaScript file is required');
    return 2;
  }

  const violations = candidateEvidenceIntrinsicViolations(
    fs.readFileSync(targetPath, 'utf8'));
  if (violations.length > 0) {
    console.error(`[CANDIDATE-INTRINSIC-POLICY] violations=${violations.join('; ')}`);
    return violations.some((value) => value.startsWith('parse=')) ? 2 : 1;
  }
  console.log('[CANDIDATE-INTRINSIC-POLICY PASS] load-bearing members are immutable');
  return 0;
}

module.exports = { candidateEvidenceIntrinsicViolations };

if (require.main === module) {
  process.exit(runCli(process.argv));
}
