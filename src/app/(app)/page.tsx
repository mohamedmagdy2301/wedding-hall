import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/lib/i18n";
import { getHomeSetupCard, requireUser } from "@/server/dal";

/** Temporary home page; S-03 comes in phase 11. Owners see the setup card until it is complete (S-14). */
export default async function HomePage() {
  const user = await requireUser();
  const setup = await getHomeSetupCard();
  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold" data-testid="welcome">
        {t.home.welcome} {user.name}
      </h1>
      {setup && (
        <Card className="max-w-xl" data-testid="setup-card">
          <CardHeader>
            <CardTitle>{t.setup.cardTitle}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              {t.setup.cardBody} {t.setup.progress} {setup.done} {t.setup.of} {setup.total}.
            </p>
            <div>
              <Button asChild>
                <Link href="/setup">{t.setup.open}</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <p className="text-muted-foreground">{t.home.placeholder}</p>
    </section>
  );
}
