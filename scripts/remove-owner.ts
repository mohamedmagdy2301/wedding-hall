import { parseArgs } from "node:util";
import { removeOwner } from "../src/modules/users-rbac/support";
import { confirm } from "./lib/prompt";
import { fail, scriptDeps } from "./lib/services";

/**
 * Support script (P1-11): removes ownership from an owner. Owners cannot do this to each
 * other inside the app. Another active owner must remain. Audited as support.owner_removed.
 * The user keeps their account and roles; an owner can then deactivate it in the app.
 *
 *   npm run support:remove-owner -- --login <owner login> [--yes]
 */
async function main() {
  const { values } = parseArgs({ options: { login: { type: "string" }, yes: { type: "boolean", default: false } } });
  if (!values.login) throw new Error("Pass --login <owner login>.");

  await confirm(`Remove ownership from "${values.login}"?`, values.yes);
  const { deps, handle } = scriptDeps();
  try {
    const result = await removeOwner(deps, { login: values.login });
    console.log(`Ownership removed from ${result.name}. Recorded in the audit log.`);
  } finally {
    await handle.close();
  }
}

main().catch(fail);
