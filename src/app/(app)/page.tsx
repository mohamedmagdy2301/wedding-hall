import { t } from "@/lib/i18n";
import { requireUser } from "@/server/dal";

/** Temporary home page; S-03 comes in phase 11. */
export default async function HomePage() {
  const user = await requireUser();
  return (
    <section className="grid gap-2">
      <h1 className="text-2xl font-bold" data-testid="welcome">
        {t.home.welcome} {user.name}
      </h1>
      <p className="text-muted-foreground">{t.home.placeholder}</p>
    </section>
  );
}
