import { parseArgs } from "node:util";
import { resetOwnerPassword } from "../src/modules/users-rbac/support";
import { askNewPassword, confirm } from "./lib/prompt";
import { fail, scriptDeps } from "./lib/services";

/**
 * Support script (P1-11): sets a temporary password for an owner who forgot theirs (there
 * is no e-mail/SMS recovery — T-11). Typed hidden, never printed; the owner must change it
 * at first login; the owner's open sessions end. Audited as support.owner_password_reset.
 *
 *   npm run support:reset-owner-password -- --login <owner login> [--yes]
 */
async function main() {
  const { values } = parseArgs({ options: { login: { type: "string" }, yes: { type: "boolean", default: false } } });
  if (!values.login) throw new Error("Pass --login <owner login>.");

  await confirm(`Reset the password of owner "${values.login}"?`, values.yes);
  const tempPassword = await askNewPassword("Temporary password (min 8 characters, hidden)");
  const { deps, handle } = scriptDeps();
  try {
    const result = await resetOwnerPassword(deps, { login: values.login, tempPassword });
    console.log(`Temporary password set for ${result.name}; it must be changed at first login. Not printed or logged.`);
  } finally {
    await handle.close();
  }
}

main().catch(fail);
