// The legacy list of the API contract only shrinks (issue 662): the operations frozen in
// docs/contracts/core-api.legacy.json at a pull request's head must all be in the file at its merge
// base, so completing an operation removes an entry and nothing can be added to hide a new one.
//
//   node scripts/check-contract-legacy-shrinks.mjs <base-legacy.json> <head-legacy.json>
//
// Exit 0 when every head operation is in the base list, 1 and the added ones listed when not, 2 on a
// file that is not a legacy list. .github/workflows/contract.yml runs it with the two versions of the
// file read from git; the core's own test (packages/nucleo/test/api/contract-ratchet.test.ts) runs it
// on planted lists.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The operationIds of a parsed legacy list. */
export function operationsOf(list) {
  const operations = typeof list === 'object' && list !== null ? list.operations : undefined;
  if (!Array.isArray(operations) || !operations.every((o) => typeof o === 'string')) throw new Error('not a legacy list: no "operations" array of strings');
  return operations;
}

/** The operations of `head` that `base` does not have, sorted: what a pull request added to the list. */
export function addedOperations(base, head) {
  const frozen = new Set(operationsOf(base));
  return [...new Set(operationsOf(head))].filter((o) => !frozen.has(o)).sort();
}

const readList = (file) => JSON.parse(readFileSync(file, 'utf8'));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [baseFile, headFile] = process.argv.slice(2);
  if (!baseFile || !headFile) {
    console.error('usage: node scripts/check-contract-legacy-shrinks.mjs <base-legacy.json> <head-legacy.json>');
    process.exit(2);
  }
  try {
    const added = addedOperations(readList(baseFile), readList(headFile));
    if (added.length > 0) {
      console.error(`The legacy list only shrinks. Added since the merge base: ${added.join(', ')}. Declare a real response schema for them instead.`);
      process.exit(1);
    }
    console.log('The legacy list did not grow.');
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : 'unreadable list'}`);
    process.exit(2);
  }
}
