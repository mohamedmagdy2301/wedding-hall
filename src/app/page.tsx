import { connection } from "next/server";
import { Suspense } from "react";
import { DbCheckForm } from "@/components/db-check-form";
import { getDb } from "@/db/request";
import { t } from "@/lib/i18n";
import { getVenueSummary } from "@/modules/settings/repository";

async function VenueName() {
  await connection();
  const venue = await getVenueSummary(getDb());
  return (
    <p className="text-lg" data-testid="venue-name">
      {venue ? venue.name : t.home.venueMissing}
    </p>
  );
}

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-2xl font-bold">{t.app.name}</h1>
        <p className="text-muted">{t.app.description}</p>
      </header>
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-1 text-sm text-muted">{t.home.venueLabel}</h2>
        <Suspense fallback={<p className="text-muted">{t.home.venueLoading}</p>}>
          <VenueName />
        </Suspense>
      </section>
      <DbCheckForm />
    </main>
  );
}
