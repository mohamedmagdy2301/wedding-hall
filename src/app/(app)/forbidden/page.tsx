import Link from "next/link";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { requireUser } from "@/server/dal";

export default async function ForbiddenPage() {
  await requireUser();
  return (
    <section className="grid justify-items-start gap-4">
      <h1 className="text-xl font-bold">{t.forbidden.title}</h1>
      <Button asChild variant="outline">
        <Link href="/">{t.forbidden.back}</Link>
      </Button>
    </section>
  );
}
