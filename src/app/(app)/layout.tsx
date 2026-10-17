import { AppHeader } from "@/components/shell/app-header";
import { SessionKeepAlive } from "@/components/shell/session-keep-alive";
import { getShellData } from "@/server/dal";

/**
 * Signed-in shell. The session check here is an extra layer only (P1-08): every page and
 * data function checks it again, since layouts do not re-run on client navigation.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user, venueName } = await getShellData();
  return (
    <>
      <AppHeader user={user} venueName={venueName} />
      <SessionKeepAlive />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6">{children}</main>
    </>
  );
}
